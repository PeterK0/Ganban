//! Minimal, tolerant iCalendar (RFC 5545) VEVENT parser — just enough to import
//! external calendar feeds into Ganban's flat event model.
//!
//! Scope/limitations (documented on purpose):
//! - No recurrence expansion. The event model is single-date, so an RRULE event
//!   is imported as its base (DTSTART) occurrence only.
//! - Times are taken as wall-clock. We do not resolve TZID or convert UTC ('Z')
//!   to local, since `chrono-tz` isn't a dependency — the HH:MM as written is
//!   stored. VALUE=DATE (or a date-only value) is treated as an all-day event.
//! - Line unfolding runs first, so a BEGIN/END:VEVENT marker that is itself
//!   indented (leading space/tab) is treated as a folded continuation of the
//!   previous line, not a marker. Compliant feeds never indent markers.

use crate::models::ParsedIcsEvent;
use chrono::{Local, NaiveDate, TimeZone, Utc};

/// Parse the text of an ICS feed into events. Malformed VEVENTs are skipped.
pub fn parse_ics(text: &str) -> Vec<ParsedIcsEvent> {
    let lines = unfold(text);
    let mut out = Vec::new();
    let mut cur: Option<RawEvent> = None;
    for line in &lines {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            cur = Some(RawEvent::default());
        } else if upper == "END:VEVENT" {
            if let Some(ev) = cur.take() {
                if let Some(parsed) = ev.finish() {
                    out.push(parsed);
                }
            }
        } else if let Some(ev) = cur.as_mut() {
            ev.feed(line);
        }
    }
    out
}

#[derive(Default)]
struct RawEvent {
    uid: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    /// (date, HH:MM, all_day)
    dtstart: Option<(NaiveDate, Option<String>, bool)>,
    dtend: Option<(NaiveDate, Option<String>, bool)>,
    /// The RRULE line's value (recurrence), if present.
    rrule: Option<String>,
}

impl RawEvent {
    fn feed(&mut self, line: &str) {
        let (name, params, value) = match split_prop(line) {
            Some(t) => t,
            None => return,
        };
        match name.as_str() {
            "UID" => self.uid = Some(value.trim().to_string()),
            "SUMMARY" => self.summary = Some(unescape(&value)),
            "DESCRIPTION" => self.description = Some(unescape(&value)),
            "LOCATION" => self.location = Some(unescape(&value)),
            "DTSTART" => self.dtstart = parse_dt(&params, &value),
            "DTEND" => self.dtend = parse_dt(&params, &value),
            "RRULE" => self.rrule = Some(value.trim().to_string()).filter(|s| !s.is_empty()),
            _ => {}
        }
    }

    fn finish(self) -> Option<ParsedIcsEvent> {
        let (date, start_time, all_day) = self.dtstart?;
        // Anchor at NOON UTC, not midnight: the UI buckets by the event_date's
        // *local* calendar day, and noon UTC stays on the same date for every
        // real timezone (UTC-11..+13) — midnight UTC would shift all-day events
        // a day early for users west of UTC.
        let event_date = Utc.from_utc_datetime(&date.and_hms_opt(12, 0, 0)?);
        let title = self
            .summary
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "(untitled)".into());
        let end_time = self.dtend.and_then(|(_, t, _)| t);
        // Stable dedup key: prefer the feed's UID, else synthesize from
        // title+date+start (include the time so same-title same-day sessions —
        // e.g. two lectures — don't collapse onto one row).
        let uid = self.uid.filter(|u| !u.is_empty()).unwrap_or_else(|| {
            format!("{title}@{}T{}", date.format("%Y%m%d"), start_time.as_deref().unwrap_or("allday"))
        });
        Some(ParsedIcsEvent {
            uid,
            title,
            description: self.description.filter(|s| !s.is_empty()),
            location: self.location.filter(|s| !s.is_empty()),
            event_date,
            start_time: if all_day { None } else { start_time },
            end_time: if all_day { None } else { end_time },
            all_day,
            rrule: self.rrule,
        })
    }
}

/// Join RFC 5545 folded lines: a line beginning with a space or tab continues
/// the previous one (with the single leading whitespace removed).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&line[1..]);
        } else {
            out.push(line.to_string());
        }
    }
    out
}

/// Unescape RFC 5545 TEXT values: `\n`/`\N` -> newline, `\,` `\;` `\\` literal.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other), // \, \; \\ -> the literal char
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Split `NAME;PARAM=v;..:VALUE` into (NAME upper, [PARAMS upper], value).
/// The name/value boundary is the first colon that isn't inside a quoted param
/// value (so e.g. `DTSTART;TZID="X:Y":..` splits at the right colon).
fn split_prop(line: &str) -> Option<(String, Vec<String>, String)> {
    let mut in_quote = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ':' if !in_quote => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let head = &line[..colon];
    let value = line[colon + 1..].to_string();
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts.map(|p| p.trim().to_ascii_uppercase()).collect();
    Some((name, params, value))
}

/// Parse an ICS date or date-time value into (date, HH:MM, all_day).
fn parse_dt(params: &[String], value: &str) -> Option<(NaiveDate, Option<String>, bool)> {
    let is_date = params.iter().any(|p| p == "VALUE=DATE");
    let v = value.trim();
    if v.len() < 8 {
        return None;
    }
    let y: i32 = v.get(0..4)?.parse().ok()?;
    let mo: u32 = v.get(4..6)?.parse().ok()?;
    let d: u32 = v.get(6..8)?.parse().ok()?;
    let date = NaiveDate::from_ymd_opt(y, mo, d)?;
    // All-day when VALUE=DATE, or there's no usable time component.
    if is_date || !v.contains('T') || v.len() < 13 {
        return Some((date, None, true));
    }
    // Validate HH/MM as in-range digits (mirror y/mo/d). On junk, keep the event
    // as all-day (preserve the date) rather than dropping it or emitting a
    // malformed string like "é:30".
    let t = match v.get(9..) {
        Some(t) => t, // after "YYYYMMDDT"
        None => return Some((date, None, true)),
    };
    let hh = t.get(0..2).and_then(|s| s.parse::<u32>().ok());
    let mm = t.get(2..4).and_then(|s| s.parse::<u32>().ok());
    let (h, m) = match (hh, mm) {
        (Some(h), Some(m)) if h <= 23 && m <= 59 => (h, m),
        _ => return Some((date, None, true)),
    };
    // A trailing 'Z' means the time is UTC — convert to the host's local zone
    // (incl. DST) so the stored wall-clock matches the viewer's calendar,
    // otherwise a UTC feed shows e.g. an hour behind in BST. Floating times (no
    // Z) and TZID-zoned times are taken as wall-clock (chrono-tz isn't a dep, so
    // named zones can't be resolved precisely).
    if v.ends_with('Z') {
        if let Some(naive) = date.and_hms_opt(h, m, 0) {
            let local = Utc.from_utc_datetime(&naive).with_timezone(&Local);
            return Some((local.date_naive(), Some(local.format("%H:%M").to_string()), false));
        }
    }
    Some((date, Some(format!("{h:02}:{m:02}")), false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timed_and_all_day() {
        // Floating (no Z) times stay wall-clock and are timezone-independent.
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc-123\r\nSUMMARY:FTD - Lecture 01\r\nDTSTART:20260615T130000\r\nDTEND:20260615T145000\r\nLOCATION:Room 5\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:def-456\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260620\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let evs = parse_ics(ics);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].uid, "abc-123");
        assert_eq!(evs[0].title, "FTD - Lecture 01");
        assert_eq!(evs[0].start_time.as_deref(), Some("13:00"));
        assert_eq!(evs[0].end_time.as_deref(), Some("14:50"));
        assert_eq!(evs[0].location.as_deref(), Some("Room 5"));
        assert!(!evs[0].all_day);
        assert!(evs[1].all_day);
        assert_eq!(evs[1].start_time, None);
    }

    #[test]
    fn quoted_colon_param_does_not_drop_event() {
        // TZID with a colon inside quotes must not break the name/value split.
        let ics = "BEGIN:VEVENT\r\nUID:z\r\nSUMMARY:Zoned\r\nDTSTART;TZID=\"X:Y\":20260615T090000\r\nEND:VEVENT\r\n";
        let evs = parse_ics(ics);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].start_time.as_deref(), Some("09:00"));
    }

    #[test]
    fn uidless_same_title_same_day_stay_distinct() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Lecture\r\nDTSTART:20260615T090000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Lecture\r\nDTSTART:20260615T140000\r\nEND:VEVENT\r\n";
        let evs = parse_ics(ics);
        assert_eq!(evs.len(), 2);
        assert_ne!(evs[0].uid, evs[1].uid); // include the time => distinct dedup keys
    }

    #[test]
    fn rejects_garbage_time() {
        let ics = "BEGIN:VEVENT\r\nUID:g\r\nSUMMARY:Junk\r\nDTSTART:20260101Txx0000\r\nEND:VEVENT\r\n";
        let evs = parse_ics(ics);
        assert_eq!(evs.len(), 1);
        assert!(evs[0].all_day); // bad HH:MM falls back to all-day, not "xx:00"
        assert_eq!(evs[0].start_time, None);
    }

    #[test]
    fn unfolds_and_unescapes() {
        let ics = "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Long title that is\r\n  folded across lines\r\nDESCRIPTION:line one\\nline two\\, still going\r\nDTSTART:20260101\r\nEND:VEVENT\r\n";
        let evs = parse_ics(ics);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].title, "Long title that is folded across lines");
        assert_eq!(evs[0].description.as_deref(), Some("line one\nline two, still going"));
        assert!(evs[0].all_day);
    }
}
