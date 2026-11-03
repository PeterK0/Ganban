//! The share door's deterministic zip: every byte offset is known before the first byte is
//! sent, from the entries' names, sizes, CRC-32s and mtimes alone.
//!
//! Files are stored (not compressed), so an entry is its local header followed by the
//! file's bytes as they are on disk; the central directory and end records follow. There
//! are no data descriptors. Zip64 extra fields and the zip64 end records appear only where
//! a value doesn't fit 32 bits (a file or an offset of 4 GB or more, or 65,535+ entries),
//! because macOS's Archive Utility is fussy about needless zip64.
//!
//! Headers are kept in memory (a few dozen bytes per file); file bytes are never held: a
//! byte range maps onto [`Piece`]s that are header slices or file slices.

use chrono::{DateTime, Datelike, Timelike};
use sha2::{Digest, Sha256};

/// The largest value a 32-bit field holds; it's also zip64's "look in the extra field".
const MAX32: u64 = 0xFFFF_FFFF;
const MAX16: u64 = 0xFFFF;
/// Bit 11: the names are UTF-8.
const FLAG_UTF8: u16 = 0x0800;

/// One file of the archive.
#[derive(Debug, Clone)]
pub struct Entry {
    /// The path inside the archive, with `/` between folders.
    pub name: String,
    pub size: u64,
    pub crc: u32,
    /// Unix seconds; written as the entry's DOS time (local) and its UT field (exact).
    pub mtime: i64,
}

/// A run of the archive's bytes.
#[derive(Debug, Clone)]
enum Part {
    /// Header bytes.
    Bytes(Vec<u8>),
    /// The bytes of entry `i`.
    File(usize),
}

/// A slice of the archive to send: header bytes, or bytes `offset..offset+len` of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Bytes(Vec<u8>),
    File { entry: usize, offset: u64, len: u64 },
}

/// The archive's layout.
#[derive(Debug, Clone)]
pub struct Layout {
    pub entries: Vec<Entry>,
    /// Each part with its starting offset.
    parts: Vec<(u64, Part)>,
    total: u64,
    etag: String,
}

fn u16le(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn u32le(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn u64le(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// `(time, date)` in DOS format, in the host's local time (as zip tools expect, and as
/// macOS's Archive Utility and `ditto` read it: they ignore the UT field), clamped to the
/// years it can hold.
fn dos_time(mtime: i64) -> (u16, u16) {
    let t = DateTime::from_timestamp(mtime, 0).unwrap_or_default().with_timezone(&chrono::Local).naive_local();
    if t.year() < 1980 {
        return (0, (1 << 5) | 1); // 1980-01-01 00:00
    }
    if t.year() > 2107 {
        return ((23 << 11) | (59 << 5) | 29, (127 << 9) | (12 << 5) | 31);
    }
    let time = (t.hour() << 11) | (t.minute() << 5) | (t.second() / 2);
    let date = (((t.year() - 1980) as u32) << 9) | (t.month() << 5) | t.day();
    (time as u16, date as u16)
}

/// The Info-ZIP extended timestamp (`UT`, 0x5455) with the mtime in Unix seconds, so tools
/// restore the true time (the DOS time has no zone). Empty for a time it can't hold.
fn ut_field(mtime: i64) -> Vec<u8> {
    let Ok(t) = u32::try_from(mtime) else { return Vec::new() };
    let mut f = Vec::with_capacity(9);
    u16le(&mut f, 0x5455);
    u16le(&mut f, 5);
    f.push(1); // the mtime is present
    u32le(&mut f, t);
    f
}

/// A 32-bit field: the value, or the zip64 marker.
fn field32(v: u64) -> u32 {
    if v >= MAX32 {
        MAX32 as u32
    } else {
        v as u32
    }
}

impl Layout {
    /// Lay out an archive of `entries`, in order.
    pub fn new(entries: Vec<Entry>) -> Layout {
        let mut parts = Vec::with_capacity(entries.len() * 2 + 1);
        let mut offset = 0u64;
        let mut central = Vec::new();
        for (i, e) in entries.iter().enumerate() {
            let name = e.name.as_bytes();
            let big = e.size >= MAX32;
            let (time, date) = dos_time(e.mtime);
            let version: u16 = if big { 45 } else { 20 };

            // Local header. A zip64 local header carries both sizes in its extra field.
            let mut local = Vec::with_capacity(30 + name.len() + 20);
            u32le(&mut local, 0x0403_4b50);
            u16le(&mut local, version);
            u16le(&mut local, FLAG_UTF8);
            u16le(&mut local, 0); // stored
            u16le(&mut local, time);
            u16le(&mut local, date);
            u32le(&mut local, e.crc);
            u32le(&mut local, field32(e.size));
            u32le(&mut local, field32(e.size));
            let ut = ut_field(e.mtime);
            u16le(&mut local, name.len() as u16);
            u16le(&mut local, if big { 20 } else { 0 } + ut.len() as u16);
            local.extend_from_slice(name);
            if big {
                u16le(&mut local, 0x0001);
                u16le(&mut local, 16);
                u64le(&mut local, e.size);
                u64le(&mut local, e.size);
            }
            local.extend_from_slice(&ut);
            let local_offset = offset;
            offset += local.len() as u64;
            parts.push((local_offset, Part::Bytes(local)));
            parts.push((offset, Part::File(i)));
            offset += e.size;

            // Central directory entry. Its zip64 extra holds only the fields that overflow,
            // in the spec's order.
            let mut extra = Vec::new();
            if big {
                u64le(&mut extra, e.size);
                u64le(&mut extra, e.size);
            }
            if local_offset >= MAX32 {
                u64le(&mut extra, local_offset);
            }
            let version: u16 = if extra.is_empty() { 20 } else { 45 };
            u32le(&mut central, 0x0201_4b50);
            u16le(&mut central, (3 << 8) | version); // made by: Unix
            u16le(&mut central, version);
            u16le(&mut central, FLAG_UTF8);
            u16le(&mut central, 0);
            u16le(&mut central, time);
            u16le(&mut central, date);
            u32le(&mut central, e.crc);
            u32le(&mut central, field32(e.size));
            u32le(&mut central, field32(e.size));
            u16le(&mut central, name.len() as u16);
            let zip64_len = if extra.is_empty() { 0 } else { extra.len() as u16 + 4 };
            u16le(&mut central, zip64_len + ut.len() as u16);
            u16le(&mut central, 0); // comment
            u16le(&mut central, 0); // disk
            u16le(&mut central, 0); // internal attributes
            u32le(&mut central, 0o100644 << 16); // a regular file, rw-r--r--
            u32le(&mut central, field32(local_offset));
            central.extend_from_slice(name);
            if !extra.is_empty() {
                u16le(&mut central, 0x0001);
                u16le(&mut central, extra.len() as u16);
                central.extend_from_slice(&extra);
            }
            central.extend_from_slice(&ut);
        }

        let cd_offset = offset;
        let cd_size = central.len() as u64;
        let count = entries.len() as u64;
        let mut tail = central;
        if count >= MAX16 || cd_size >= MAX32 || cd_offset >= MAX32 {
            let eocd64 = cd_offset + cd_size;
            u32le(&mut tail, 0x0606_4b50);
            u64le(&mut tail, 44);
            u16le(&mut tail, (3 << 8) | 45);
            u16le(&mut tail, 45);
            u32le(&mut tail, 0);
            u32le(&mut tail, 0);
            u64le(&mut tail, count);
            u64le(&mut tail, count);
            u64le(&mut tail, cd_size);
            u64le(&mut tail, cd_offset);
            // The locator.
            u32le(&mut tail, 0x0706_4b50);
            u32le(&mut tail, 0);
            u64le(&mut tail, eocd64);
            u32le(&mut tail, 1);
        }
        u32le(&mut tail, 0x0605_4b50);
        u16le(&mut tail, 0);
        u16le(&mut tail, 0);
        u16le(&mut tail, count.min(MAX16) as u16);
        u16le(&mut tail, count.min(MAX16) as u16);
        u32le(&mut tail, field32(cd_size));
        u32le(&mut tail, field32(cd_offset));
        u16le(&mut tail, 0);

        // The central directory names every entry's name, size, CRC, time and offset.
        let digest = Sha256::digest(&tail);
        let etag = format!("\"z-{}\"", digest[..12].iter().map(|b| format!("{b:02x}")).collect::<String>());
        let total = offset + tail.len() as u64;
        parts.push((offset, Part::Bytes(tail)));
        Layout { entries, parts, total, etag }
    }

    /// The archive's exact length.
    pub fn len(&self) -> u64 {
        self.total
    }

    /// A strong ETag: the same files with the same contents give the same one.
    pub fn etag(&self) -> &str {
        &self.etag
    }

    /// The pieces covering bytes `start..=end` of the archive.
    pub fn pieces(&self, start: u64, end: u64) -> Vec<Piece> {
        let mut out = Vec::new();
        if start > end || start >= self.total {
            return out;
        }
        let end = end.min(self.total - 1);
        // The first part that ends after `start`.
        let first = self.parts.partition_point(|(off, part)| off + self.part_len(part) <= start);
        for (off, part) in &self.parts[first..] {
            if *off > end {
                break;
            }
            let len = self.part_len(part);
            if len == 0 {
                continue;
            }
            let from = start.max(*off) - off;
            let to = (end + 1).min(off + len) - off; // exclusive
            match part {
                Part::Bytes(b) => out.push(Piece::Bytes(b[from as usize..to as usize].to_vec())),
                Part::File(i) => out.push(Piece::File { entry: *i, offset: from, len: to - from }),
            }
        }
        out
    }

    fn part_len(&self, part: &Part) -> u64 {
        match part {
            Part::Bytes(b) => b.len() as u64,
            Part::File(i) => self.entries[*i].size,
        }
    }

    /// Every header byte, in order (for tests).
    #[cfg(test)]
    fn header_bytes(&self) -> Vec<u8> {
        let mut all = Vec::new();
        for (_, p) in &self.parts {
            if let Part::Bytes(b) = p {
                all.extend_from_slice(b);
            }
        }
        all
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, size: u64) -> Entry {
        Entry { name: name.into(), size, crc: 0x1234_5678, mtime: 1_762_000_000 }
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    const EOCD64: [u8; 4] = 0x0606_4b50u32.to_le_bytes();
    const LOCATOR: [u8; 4] = 0x0706_4b50u32.to_le_bytes();

    #[test]
    fn small_archives_have_no_zip64() {
        let l = Layout::new(vec![entry("a/one.txt", 10), entry("a/b/two.bin", 3_000_000)]);
        let h = l.header_bytes();
        assert!(!contains(&h, &EOCD64) && !contains(&h, &LOCATOR));
        assert!(!contains(&h, &[0x01, 0x00, 0x10, 0x00]), "no zip64 extra field");
        // 2 local headers + data + 2 central entries + EOCD; each header has a 9-byte UT field.
        let names = "a/one.txt".len() + "a/b/two.bin".len();
        assert_eq!(l.len(), (39 * 2 + 55 * 2 + 22 + names * 2) as u64 + 10 + 3_000_000);
    }

    #[test]
    fn zip64_appears_only_past_the_threshold() {
        // A fake 5 GB entry (no file is read), then a small one whose offset is past 4 GB.
        let five_gb = 5 * 1024 * 1024 * 1024u64;
        let l = Layout::new(vec![entry("big.iso", five_gb), entry("after.txt", 5)]);
        let h = l.header_bytes();
        assert!(contains(&h, &EOCD64) && contains(&h, &LOCATOR), "zip64 end records");

        // The big entry's local header: sizes marked, both in its extra field.
        let Part::Bytes(local) = &l.parts[0].1 else { panic!() };
        assert_eq!(&local[18..26], &[0xFF; 8]);
        assert_eq!(u16::from_le_bytes([local[28], local[29]]), 20 + 9);
        let extra = &local[30 + "big.iso".len()..];
        assert_eq!(&extra[..4], &[0x01, 0x00, 0x10, 0x00]);
        assert_eq!(u64::from_le_bytes(extra[4..12].try_into().unwrap()), five_gb);

        // The small entry's local header needs no zip64: its size fits.
        let Part::Bytes(local2) = &l.parts[2].1 else { panic!() };
        assert_eq!(u16::from_le_bytes([local2[28], local2[29]]), 9, "only the UT field");
        assert_eq!(u16::from_le_bytes([local2[4], local2[5]]), 20);

        // Its central entry carries only the offset in a zip64 extra (8 bytes).
        let Part::Bytes(tail) = &l.parts[4].1 else { panic!() };
        let second = 46 + "big.iso".len() + 4 + 16 + 9;
        let c2 = &tail[second..];
        assert_eq!(&c2[0..4], &0x0201_4b50u32.to_le_bytes());
        assert_eq!(&c2[42..46], &[0xFF; 4], "offset marked");
        assert_eq!(u16::from_le_bytes([c2[30], c2[31]]), 12 + 9, "extra: zip64 with one u64, then UT");
        let off = u64::from_le_bytes(c2[46 + 9 + 4..46 + 9 + 12].try_into().unwrap());
        assert_eq!(off, 30 + 7 + 20 + 9 + five_gb);
    }

    #[test]
    fn a_file_of_exactly_4gb_minus_one_is_zip64_too() {
        // 0xFFFFFFFF is the zip64 marker, so it can't be written as a plain size.
        let l = Layout::new(vec![entry("edge.bin", MAX32)]);
        let Part::Bytes(local) = &l.parts[0].1 else { panic!() };
        assert_eq!(u16::from_le_bytes([local[28], local[29]]), 20 + 9);
        let l = Layout::new(vec![entry("edge.bin", MAX32 - 1)]);
        let Part::Bytes(local) = &l.parts[0].1 else { panic!() };
        assert_eq!(u16::from_le_bytes([local[28], local[29]]), 9);
    }

    #[test]
    fn pieces_cover_a_range_exactly() {
        let l = Layout::new(vec![entry("a.txt", 100), entry("b.txt", 50)]);
        let total: u64 = l.pieces(0, l.len() - 1).iter().map(|p| match p {
            Piece::Bytes(b) => b.len() as u64,
            Piece::File { len, .. } => *len,
        }).sum();
        assert_eq!(total, l.len());
        // Bytes 50..=70 sit inside a.txt (its data starts at 30 + 5 + 9).
        assert_eq!(l.pieces(50, 70), vec![Piece::File { entry: 0, offset: 6, len: 21 }]);
        // Out of range gives nothing.
        assert!(l.pieces(l.len(), l.len() + 5).is_empty());
    }

    #[test]
    fn the_etag_follows_the_contents() {
        let a = Layout::new(vec![entry("a.txt", 100)]);
        let b = Layout::new(vec![entry("a.txt", 100)]);
        let mut c = entry("a.txt", 100);
        c.crc = 1;
        assert_eq!(a.etag(), b.etag());
        assert_ne!(a.etag(), Layout::new(vec![c]).etag());
    }
}
