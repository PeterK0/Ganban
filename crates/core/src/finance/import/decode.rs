//! Cell-level decoding: Excel serial dates, mojibake repair, amounts and dates.
//!
//! Everything here is pure and works on one value (or one column) at a time.

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

/// Decimal digits of a currency's minor unit (ISO 4217). Unknown codes count as 2.
pub fn currency_exponent(currency: &str) -> u32 {
    match currency.to_ascii_uppercase().as_str() {
        "JPY" | "KRW" | "ISK" | "CLP" | "VND" | "XOF" | "XAF" | "UGX" | "PYG" | "RWF" => 0,
        "BHD" | "KWD" | "OMR" | "JOD" | "TND" | "IQD" | "LYD" => 3,
        _ => 2,
    }
}

/// True for a plausible ISO 4217 code: three ASCII capitals.
pub fn is_currency_code(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
}

// ---------------------------------------------------------------------------
// Excel serial dates
// ---------------------------------------------------------------------------

/// An Excel serial date-time (1900 date system) as a `NaiveDateTime`, to the second.
///
/// Serial 1 is 1900-01-01. Excel's phantom 1900-02-29 (serial 60) reads as
/// 1900-03-01, and every later serial is exact. Returns `None` for negative or absurd values.
pub fn excel_serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    if !serial.is_finite() || !(0.0..2_958_466.0).contains(&serial) {
        return None;
    }
    let mut days = serial.floor() as i64;
    let mut secs = ((serial - serial.floor()) * 86_400.0).round() as i64;
    if secs >= 86_400 {
        days += 1;
        secs -= 86_400;
    }
    let base = if days >= 61 {
        NaiveDate::from_ymd_opt(1899, 12, 30)?
    } else {
        // Before the phantom leap day the offset is one day smaller.
        NaiveDate::from_ymd_opt(1899, 12, 31)?
    };
    let date = base.checked_add_signed(Duration::days(days))?;
    let time = NaiveTime::from_num_seconds_from_midnight_opt(secs as u32, 0)?;
    Some(NaiveDateTime::new(date, time))
}

/// True when a number is plausibly a serial date between 1955 and 2119.
pub fn looks_like_serial_date(n: f64) -> bool {
    (20_000.0..80_000.0).contains(&n)
}

// ---------------------------------------------------------------------------
// Mojibake
// ---------------------------------------------------------------------------

/// cp1252's 0x80–0x9F block, as Unicode. `None` marks the five bytes cp1252 leaves
/// undefined; decoders pass those through as the C1 control of the same value.
const CP1252_HIGH: [Option<char>; 32] = [
    Some('€'), None, Some('‚'), Some('ƒ'), Some('„'), Some('…'), Some('†'), Some('‡'),
    Some('ˆ'), Some('‰'), Some('Š'), Some('‹'), Some('Œ'), None, Some('Ž'), None,
    None, Some('‘'), Some('’'), Some('“'), Some('”'), Some('•'), Some('–'), Some('—'),
    Some('˜'), Some('™'), Some('š'), Some('›'), Some('œ'), None, Some('ž'), Some('Ÿ'),
];

fn cp1252_byte(c: char) -> Option<u8> {
    let u = c as u32;
    if u < 0x80 || (0xA0..=0xFF).contains(&u) {
        return Some(u as u8);
    }
    if (0x80..=0x9F).contains(&u) {
        // A C1 control: only the undefined slots round-trip this way.
        let i = (u - 0x80) as usize;
        return CP1252_HIGH[i].is_none().then_some(u as u8);
    }
    CP1252_HIGH.iter().position(|m| *m == Some(c)).map(|i| 0x80 + i as u8)
}

/// Repairs text that was UTF-8 but got decoded as cp1252 ("WOÎ›T" → "WOΛT",
/// "ðŸ’¸" → "💸"). The text is re-encoded to cp1252 bytes and re-decoded as UTF-8;
/// the repair is kept only when every character maps and the bytes are valid UTF-8,
/// so genuine accented text ("Café") is left alone.
pub fn repair_mojibake(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let mut bytes = Vec::with_capacity(s.len());
    for c in s.chars() {
        match cp1252_byte(c) {
            Some(b) => bytes.push(b),
            None => return s.to_string(),
        }
    }
    match String::from_utf8(bytes) {
        Ok(fixed) if fixed != s => fixed,
        _ => s.to_string(),
    }
}

/// Trims, turns no-break spaces into spaces and collapses runs of whitespace.
pub fn clean_text(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == '\u{a0}')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/// Which character is the decimal mark in a text amount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DecimalStyle {
    /// Decide per column from the values (see [`detect_decimal_style`]).
    #[default]
    Auto,
    /// `1,234.56`
    Dot,
    /// `1.234,56`
    Comma,
}

/// Guesses a column's decimal mark from its values. A value with both marks has its
/// decimal mark last; a lone mark followed by one or two digits is decimal; a mark
/// that repeats is a thousands separator. Undecided columns default to `Dot`.
pub fn detect_decimal_style<'a>(values: impl IntoIterator<Item = &'a str>) -> DecimalStyle {
    let (mut dot, mut comma) = (0, 0);
    for v in values {
        let v = v.trim();
        let (d, c) = (v.rfind('.'), v.rfind(','));
        match (d, c) {
            (Some(d), Some(c)) => {
                if d > c { dot += 1 } else { comma += 1 }
            }
            (Some(i), None) | (None, Some(i)) => {
                let mark = v.as_bytes()[i];
                let repeats = v.bytes().filter(|b| *b == mark).count() > 1;
                let tail = v[i + 1..].chars().take_while(|c| c.is_ascii_digit()).count();
                let decimal = !repeats && (1..=2).contains(&tail);
                let thousands = repeats || tail == 3;
                match (mark, decimal, thousands) {
                    (b'.', true, _) => dot += 1,
                    (b',', true, _) => comma += 1,
                    (b'.', false, true) => comma += 1,
                    (b',', false, true) => dot += 1,
                    _ => {}
                }
            }
            (None, None) => {}
        }
    }
    if comma > dot { DecimalStyle::Comma } else { DecimalStyle::Dot }
}

/// Parses a text amount into minor units with `exponent` decimals.
///
/// Accepts a leading or trailing sign, parentheses for negatives, spaces and
/// apostrophes as group separators, and a currency code or symbol around the
/// number. `Auto` decides for this value alone; prefer detecting the column first.
pub fn parse_amount_minor(s: &str, style: DecimalStyle, exponent: u32) -> Option<i64> {
    let s = s.trim_matches(|c: char| c.is_whitespace() || c.is_alphabetic() || "€$£¥₺₹".contains(c));
    if s.is_empty() {
        return None;
    }
    let style = match style {
        DecimalStyle::Auto => detect_decimal_style([s]),
        other => other,
    };
    let (dec, group) = match style {
        DecimalStyle::Comma => (',', '.'),
        _ => ('.', ','),
    };
    let mut negative = false;
    let mut int_part = String::new();
    let mut frac_part = String::new();
    let mut seen_dec = false;
    let mut seen_digit = false;
    // A sign or bracket after the digits closes the number: nothing numeric may follow.
    let mut closed = false;
    for c in s.chars() {
        match c {
            '0'..='9' => {
                if closed {
                    return None;
                }
                seen_digit = true;
                if seen_dec { frac_part.push(c) } else { int_part.push(c) }
            }
            '-' | '−' | '(' | ')' | '+' => {
                if matches!(c, '-' | '−' | '(') {
                    negative = true;
                }
                closed |= seen_digit;
            }
            c if c == dec => {
                if seen_dec {
                    return None;
                }
                seen_dec = true;
            }
            c if c == group || c == ' ' || c == '\u{a0}' || c == '\u{202f}' || c == '\'' => {
                if seen_dec {
                    return None;
                }
            }
            c if "€$£¥₺₹".contains(c) => {}
            _ => return None,
        }
    }
    if !seen_digit {
        return None;
    }
    let exp = exponent as usize;
    if frac_part.len() > exp {
        // Round half away from zero on the first dropped digit.
        let round_up = frac_part.as_bytes()[exp] >= b'5';
        frac_part.truncate(exp);
        let mut v = assemble(&int_part, &frac_part, exp)?;
        if round_up {
            v = v.checked_add(1)?;
        }
        return Some(if negative { -v } else { v });
    }
    let v = assemble(&int_part, &frac_part, exp)?;
    Some(if negative { -v } else { v })
}

fn assemble(int_part: &str, frac_part: &str, exp: usize) -> Option<i64> {
    let mut digits = String::with_capacity(int_part.len() + exp);
    digits.push_str(if int_part.is_empty() { "0" } else { int_part });
    digits.push_str(frac_part);
    for _ in frac_part.len()..exp {
        digits.push('0');
    }
    digits.parse::<i64>().ok()
}

/// A spreadsheet number in minor units, rounded to the nearest unit.
pub fn float_to_minor(n: f64, exponent: u32) -> Option<i64> {
    if !n.is_finite() {
        return None;
    }
    let scaled = (n * 10f64.powi(exponent as i32)).round();
    (scaled.abs() < 9.0e15).then_some(scaled as i64)
}

// ---------------------------------------------------------------------------
// Text dates
// ---------------------------------------------------------------------------

/// Formats tried for text dates when a column has none set, in this order.
/// Day-first beats month-first: these are European banks.
pub const AUTO_DATE_FORMATS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%d.%m.%Y %H:%M:%S",
    "%d.%m.%Y",
    "%d-%m-%Y",
    "%d/%m/%y",
    "%m/%d/%Y",
];

/// Parses a text date or date-time with one `chrono` format.
pub fn parse_date_with(s: &str, fmt: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, fmt) {
        return Some(dt);
    }
    NaiveDate::parse_from_str(s, fmt).ok().map(|d| d.and_time(NaiveTime::MIN))
}

/// The first of `formats` that parses every non-empty value, if any.
pub fn detect_date_format<'a>(
    values: &[&'a str],
    formats: &[&'static str],
) -> Option<&'static str> {
    let values: Vec<&str> = values.iter().map(|v| v.trim()).filter(|v| !v.is_empty()).collect();
    if values.is_empty() {
        return None;
    }
    formats
        .iter()
        .copied()
        .find(|f| values.iter().all(|v| parse_date_with(v, f).is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn serial_dates() {
        assert_eq!(excel_serial_to_datetime(1.0).unwrap(), dt("1900-01-01 00:00:00"));
        assert_eq!(excel_serial_to_datetime(59.0).unwrap(), dt("1900-02-28 00:00:00"));
        assert_eq!(excel_serial_to_datetime(61.0).unwrap(), dt("1900-03-01 00:00:00"));
        assert_eq!(excel_serial_to_datetime(45943.5).unwrap(), dt("2025-10-13 12:00:00"));
        assert_eq!(excel_serial_to_datetime(46296.0).unwrap(), dt("2026-10-01 00:00:00"));
        // A time that rounds up to midnight rolls the day over.
        assert_eq!(excel_serial_to_datetime(46296.999_999_9).unwrap(), dt("2026-10-02 00:00:00"));
        assert!(excel_serial_to_datetime(-1.0).is_none());
        assert!(looks_like_serial_date(46296.5));
        assert!(!looks_like_serial_date(14.76));
    }

    #[test]
    fn mojibake_is_repaired_only_when_valid() {
        assert_eq!(repair_mojibake("WOÎ›T"), "WOΛT");
        assert_eq!(repair_mojibake("From EUR ðŸ’¸ Pocket"), "From EUR 💸 Pocket");
        assert_eq!(repair_mojibake("CafÃ©"), "Café");
        // Genuine text stays as it is.
        assert_eq!(repair_mojibake("Café"), "Café");
        assert_eq!(repair_mojibake("ΑΝΑΝΕΩΣΗ ΚΑΡΤΑΣ"), "ΑΝΑΝΕΩΣΗ ΚΑΡΤΑΣ");
        assert_eq!(repair_mojibake("plain"), "plain");
        assert_eq!(repair_mojibake("€ 5"), "€ 5");
    }

    #[test]
    fn clean_text_collapses_space() {
        assert_eq!(clean_text("  Bank fees\u{a0} "), "Bank fees");
        assert_eq!(clean_text("COMMISSION      "), "COMMISSION");
        assert_eq!(clean_text("a\n b"), "a b");
    }

    #[test]
    fn amounts_with_decimal_commas_and_thousands() {
        use DecimalStyle::*;
        assert_eq!(parse_amount_minor("-14.76", Dot, 2), Some(-1476));
        assert_eq!(parse_amount_minor("1,234.56", Dot, 2), Some(123_456));
        assert_eq!(parse_amount_minor("1.234,56", Comma, 2), Some(123_456));
        assert_eq!(parse_amount_minor("-6,00", Comma, 2), Some(-600));
        assert_eq!(parse_amount_minor("12 345,6", Comma, 2), Some(1_234_560));
        assert_eq!(parse_amount_minor("(5.00)", Dot, 2), Some(-500));
        assert_eq!(parse_amount_minor("5.00-", Dot, 2), Some(-500));
        assert_eq!(parse_amount_minor("5-3", Dot, 2), None, "a sign only at the ends");
        assert_eq!(parse_amount_minor("+30", Dot, 2), Some(3000));
        assert_eq!(parse_amount_minor("€ 7.5", Dot, 2), Some(750));
        assert_eq!(parse_amount_minor("7.5 EUR", Dot, 2), Some(750));
        assert_eq!(parse_amount_minor("100", Dot, 0), Some(100));
        assert_eq!(parse_amount_minor("1.2345", Dot, 3), Some(1235));
        assert_eq!(parse_amount_minor("0.005", Dot, 2), Some(1));
        assert_eq!(parse_amount_minor("xx.xx", Dot, 2), None);
        assert_eq!(parse_amount_minor("", Dot, 2), None);
        assert_eq!(parse_amount_minor("1.2.3", Comma, 2), Some(12_300));
        assert_eq!(parse_amount_minor("1,2,3", Comma, 2), None);
        // Auto decides per value.
        assert_eq!(parse_amount_minor("2.500,10", Auto, 2), Some(250_010));
        assert_eq!(parse_amount_minor("-3,5", Auto, 2), Some(-350));
    }

    #[test]
    fn decimal_style_detection() {
        use DecimalStyle::*;
        assert_eq!(detect_decimal_style(["1.234,56", "-6,00"]), Comma);
        assert_eq!(detect_decimal_style(["1,234.56", "-6.00"]), Dot);
        assert_eq!(detect_decimal_style(["-6,5", "100"]), Comma);
        assert_eq!(detect_decimal_style(["1.234.567", "3"]), Comma);
        assert_eq!(detect_decimal_style(["100", "3"]), Dot);
    }

    #[test]
    fn float_amounts() {
        assert_eq!(float_to_minor(-14.76, 2), Some(-1476));
        assert_eq!(float_to_minor(0.1 + 0.2, 2), Some(30));
        assert_eq!(float_to_minor(1500.0, 0), Some(1500));
        assert_eq!(float_to_minor(f64::NAN, 2), None);
    }

    #[test]
    fn exponents() {
        assert_eq!(currency_exponent("EUR"), 2);
        assert_eq!(currency_exponent("jpy"), 0);
        assert_eq!(currency_exponent("KWD"), 3);
        assert!(is_currency_code("GBP"));
        assert!(!is_currency_code("Gbp"));
    }

    #[test]
    fn text_dates() {
        assert_eq!(parse_date_with("01/10/2026", "%d/%m/%Y").unwrap(), dt("2026-10-01 00:00:00"));
        assert_eq!(
            parse_date_with("2026-10-01 13:05:00", "%Y-%m-%d %H:%M:%S").unwrap(),
            dt("2026-10-01 13:05:00")
        );
        let f = detect_date_format(&["01/10/2026", "31/10/2026"], AUTO_DATE_FORMATS);
        assert_eq!(f, Some("%d/%m/%Y"));
        assert_eq!(detect_date_format(&["10/31/2026"], AUTO_DATE_FORMATS), Some("%m/%d/%Y"));
        assert_eq!(detect_date_format(&["nope"], AUTO_DATE_FORMATS), None);
    }
}
