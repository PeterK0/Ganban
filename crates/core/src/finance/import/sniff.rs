//! Format sniffing and the CSV reader: content decides, never the file name.

use super::{Cell, Format};

/// XLSX is a zip: it starts with the local-file-header magic `PK\x03\x04`.
pub fn sniff_format(bytes: &[u8]) -> Format {
    if bytes.starts_with(b"PK\x03\x04") {
        Format::Xlsx
    } else {
        Format::Csv
    }
}

/// The text encoding a CSV was decoded from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// Western European (Windows-1252).
    Windows1252,
    /// Greek (Windows-1253), as Greek banks export.
    Windows1253,
}

/// Decodes CSV bytes to text: a BOM wins, then valid UTF-8, then a single-byte code
/// page chosen by [`guess_single_byte`].
pub fn decode_text(bytes: &[u8]) -> (String, TextEncoding) {
    use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252, WINDOWS_1253};
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return (String::from_utf8_lossy(rest).into_owned(), TextEncoding::Utf8);
    }
    if bytes.starts_with(b"\xFF\xFE") {
        let (t, _) = UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return (t.into_owned(), TextEncoding::Utf16Le);
    }
    if bytes.starts_with(b"\xFE\xFF") {
        let (t, _) = UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return (t.into_owned(), TextEncoding::Utf16Be);
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), TextEncoding::Utf8);
    }
    let enc = guess_single_byte(bytes);
    let codec = if enc == TextEncoding::Windows1253 { WINDOWS_1253 } else { WINDOWS_1252 };
    let (t, _) = codec.decode_without_bom_handling(bytes);
    (t.into_owned(), enc)
}

/// Greek or Western for a non-UTF-8 file. Greek words are runs of high bytes
/// (letters live at 0xC1–0xFE in cp1253), while Western text has a lone accented
/// letter between ASCII ones. Three or more high bytes in a row, making up most of
/// the high bytes, means Greek.
pub fn guess_single_byte(bytes: &[u8]) -> TextEncoding {
    let (mut high, mut in_runs, mut run) = (0usize, 0usize, 0usize);
    for &b in bytes.iter().chain(std::iter::once(&b' ')) {
        if b >= 0xB8 {
            high += 1;
            run += 1;
        } else {
            if run >= 3 {
                in_runs += run;
            }
            run = 0;
        }
    }
    if high > 0 && in_runs * 2 >= high {
        TextEncoding::Windows1253
    } else {
        TextEncoding::Windows1252
    }
}

/// Splits text into records with the given delimiter (RFC 4180: double quotes,
/// `""` escapes, newlines inside quotes; CRLF, LF or CR line ends).
pub fn split_records(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            c if c == delim => record.push(std::mem::take(&mut field)),
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
                any = false;
            }
            c => field.push(c),
        }
    }
    if any {
        record.push(field);
        records.push(record);
    }
    records
}

/// Picks the delimiter whose field count is largest and most consistent across the
/// first non-empty lines. Preamble lines (one field) don't spoil the vote: the
/// most common count above one wins.
pub fn detect_delimiter(text: &str) -> char {
    const CANDIDATES: [char; 4] = [',', ';', '\t', '|'];
    let sample: String = text.lines().take(40).collect::<Vec<_>>().join("\n");
    let mut best = (',', 0usize);
    for d in CANDIDATES {
        let mut counts = std::collections::HashMap::<usize, usize>::new();
        for r in split_records(&sample, d) {
            if r.len() > 1 {
                *counts.entry(r.len()).or_default() += 1;
            }
        }
        // Score: rows sharing the modal width, times that width.
        let score = counts.iter().map(|(w, n)| n * w.min(&50)).max().unwrap_or(0);
        if score > best.1 {
            best = (d, score);
        }
    }
    best.0
}

/// Reads a CSV into cells: decode, pick the delimiter, split, repair mojibake.
pub fn read_csv(bytes: &[u8]) -> (Vec<Vec<Cell>>, TextEncoding, char) {
    let (text, enc) = decode_text(bytes);
    let delim = detect_delimiter(&text);
    let rows = split_records(&text, delim)
        .into_iter()
        .map(|r| r.into_iter().map(|f| Cell::text(&f)).collect())
        .collect();
    (rows, enc, delim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_magic_means_xlsx() {
        assert_eq!(sniff_format(b"PK\x03\x04rest"), Format::Xlsx);
        assert_eq!(sniff_format(b"Type,Product\n"), Format::Csv);
        assert_eq!(sniff_format(b""), Format::Csv);
    }

    #[test]
    fn encodings() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFa,b").0, "a,b");
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("a;β".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode_text(&utf16), ("a;β".to_string(), TextEncoding::Utf16Le));
        assert_eq!(decode_text("Ποσό;β".as_bytes()).1, TextEncoding::Utf8);
        // "ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ" in cp1253.
        let greek = b"\xd0\xcb\xc7\xd1\xd9\xcc\xc7 \xca\xc1\xd1\xd4\xc1\xd3;-6,00";
        let (t, e) = decode_text(greek);
        assert_eq!(e, TextEncoding::Windows1253);
        assert_eq!(t, "ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ;-6,00");
        // "Café Müller" in cp1252.
        let (t, e) = decode_text(b"Caf\xe9 M\xfcller,1");
        assert_eq!(e, TextEncoding::Windows1252);
        assert_eq!(t, "Café Müller,1");
    }

    #[test]
    fn records_with_quotes_and_newlines() {
        let r = split_records("a,\"b,c\",\"say \"\"hi\"\"\"\r\n\"x\ny\",2\n", ',');
        assert_eq!(r, vec![vec!["a", "b,c", "say \"hi\""], vec!["x\ny", "2"]]);
        assert_eq!(split_records("a;b", ';'), vec![vec!["a", "b"]]);
        assert_eq!(split_records("a\r\rb", ','), vec![vec!["a"], vec![""], vec!["b"]]);
    }

    #[test]
    fn delimiter_detection() {
        assert_eq!(detect_delimiter("a,b,c\n1,2,3\n"), ',');
        assert_eq!(detect_delimiter("Bank\nTitle\na;b;c\n1,5;2;3\n4;5,5;6\n"), ';');
        assert_eq!(detect_delimiter("a\tb\n1\t2\n"), '\t');
        assert_eq!(detect_delimiter("\"x;y\",b\n\"1;2\",3\n"), ',');
    }
}
