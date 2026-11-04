//! The XLSX reader: the first worksheet as cells, through `calamine`.

use std::io::Cursor;

use calamine::{Data, Reader, Xlsx};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use super::{Cell, TOO_LARGE};

/// The most an XLSX may unpack to, the rows and the columns its sheet may span.
pub const MAX_UNPACKED_BYTES: u128 = 64 * 1024 * 1024;
pub const MAX_ROWS: usize = 200_000;
pub const MAX_COLS: usize = 200;
use crate::error::{AppError, Result};

/// Reads the first worksheet. Date-formatted cells become [`Cell::Date`], text is
/// mojibake-repaired, and the grid starts at A1 whatever the sheet's used range.
pub fn read_xlsx(bytes: &[u8]) -> Result<Vec<Vec<Cell>>> {
    // A small zip can unpack to a huge sheet: refuse before calamine loads it.
    let unpacked = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| AppError::InvalidInput("this spreadsheet can't be read".into()))?
        .decompressed_size()
        // Unknown when written with data descriptors (streaming writers): the row cap still holds.
        .unwrap_or(0);
    if unpacked > MAX_UNPACKED_BYTES {
        return Err(AppError::InvalidInput(TOO_LARGE.into()));
    }
    let mut book: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|_| AppError::InvalidInput("this spreadsheet can't be read".into()))?;
    let range = match book.worksheet_range_at(0) {
        Some(Ok(r)) => r,
        _ => return Err(AppError::InvalidInput("this spreadsheet has no readable sheet".into())),
    };
    let (row0, col0) = range.start().map(|(r, c)| (r as usize, c as usize)).unwrap_or((0, 0));
    let (height, width) = range.get_size();
    if row0 + height > MAX_ROWS || col0 + width > MAX_COLS {
        return Err(AppError::InvalidInput(TOO_LARGE.into()));
    }
    let mut rows: Vec<Vec<Cell>> = vec![Vec::new(); row0];
    for r in range.rows() {
        let mut out = vec![Cell::Empty; col0];
        out.extend(r.iter().map(cell_of));
        rows.push(out);
    }
    Ok(rows)
}

fn cell_of(d: &Data) -> Cell {
    match d {
        Data::Empty | Data::Error(_) => Cell::Empty,
        Data::String(s) => Cell::text(s),
        Data::Float(f) => Cell::Number(*f),
        Data::Int(i) => Cell::Number(*i as f64),
        Data::Bool(b) => Cell::Text(b.to_string()),
        Data::DateTime(x) if x.is_datetime() => {
            let (y, mo, d, h, mi, s, _ms) = x.to_ymd_hms_milli();
            NaiveDate::from_ymd_opt(y as i32, mo as u32, d as u32)
                .and_then(|date| {
                    NaiveTime::from_hms_opt(h as u32, mi as u32, s as u32)
                        .map(|t| NaiveDateTime::new(date, t))
                })
                .map(Cell::Date)
                .unwrap_or(Cell::Number(x.as_f64()))
        }
        Data::DateTime(x) => Cell::Number(x.as_f64()),
        Data::DateTimeIso(s) => NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_time(NaiveTime::MIN)))
            .map(Cell::Date)
            .unwrap_or_else(|| Cell::text(s)),
        Data::DurationIso(s) => Cell::text(s),
    }
}
