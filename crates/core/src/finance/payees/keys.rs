//! The two keys a payee's raw text is matched by (`docs/design/FINANCE.md` § Payees).
//!
//! - The **certain key** merges spellings without asking: case and accents folded,
//!   punctuation dropped, order and reference tails dropped (`*ORDER 128`, `#4471`, a
//!   trailing run of digits), and the Greek or Cyrillic letters of a word that is mostly
//!   Latin read as Latin ("WOΛT" is "wolt").
//! - The **loose key** only suggests: every Greek and Cyrillic letter transliterated, filler
//!   words dropped ("order", "payment", "ltd"). [`similar`] adds a small edit distance and
//!   two names that differ only in a last word (a branch or a city).
//!
//! Pure functions, no database.

/// Greek and Cyrillic letters that look like a Latin one, read as that letter inside a
/// mostly Latin word (a stray letter from another keyboard).
fn look_alike(c: char) -> Option<&'static str> {
    Some(match c {
        // Greek capitals and small letters with a Latin twin.
        'Α' | 'α' => "a",
        'Β' | 'β' => "b",
        'Ε' | 'ε' => "e",
        'Ζ' | 'ζ' => "z",
        'Η' => "h",
        'Ι' | 'ι' => "i",
        'Κ' | 'κ' => "k",
        'Μ' => "m",
        'Ν' => "n",
        'Ο' | 'ο' => "o",
        'Ρ' | 'ρ' => "p",
        'Τ' | 'τ' => "t",
        'Υ' | 'υ' => "y",
        'Χ' | 'χ' => "x",
        // Cyrillic.
        'А' | 'а' => "a",
        'В' => "b",
        'Е' | 'е' => "e",
        'К' | 'к' => "k",
        'М' | 'м' => "m",
        'Н' | 'н' => "h",
        'О' | 'о' => "o",
        'Р' | 'р' => "p",
        'С' | 'с' => "c",
        'Т' | 'т' => "t",
        'У' | 'у' => "y",
        'Х' | 'х' => "x",
        'І' | 'і' => "i",
        'Ѕ' | 'ѕ' => "s",
        _ => return phonetic(c),
    })
}

/// A Greek or Cyrillic letter by its sound.
fn phonetic(c: char) -> Option<&'static str> {
    let lower = c.to_lowercase().next().unwrap_or(c);
    Some(match lower {
        // Greek.
        'α' | 'ά' => "a",
        'β' => "v",
        'γ' => "g",
        'δ' => "d",
        'ε' | 'έ' => "e",
        'ζ' => "z",
        'η' | 'ή' => "i",
        'θ' => "th",
        'ι' | 'ί' | 'ϊ' | 'ΐ' => "i",
        'κ' => "k",
        'λ' => "l",
        'μ' => "m",
        'ν' => "n",
        'ξ' => "x",
        'ο' | 'ό' => "o",
        'π' => "p",
        'ρ' => "r",
        'σ' | 'ς' => "s",
        'τ' => "t",
        'υ' | 'ύ' | 'ϋ' | 'ΰ' => "y",
        'φ' => "f",
        'χ' => "ch",
        'ψ' => "ps",
        'ω' | 'ώ' => "o",
        // Cyrillic.
        'а' => "a",
        'б' => "b",
        'в' => "v",
        'г' => "g",
        'д' => "d",
        'е' | 'ё' | 'э' | 'є' => "e",
        'ж' => "zh",
        'з' => "z",
        'и' | 'і' | 'ї' | 'й' | 'ы' => "i",
        'к' => "k",
        'л' => "l",
        'м' => "m",
        'н' => "n",
        'о' => "o",
        'п' => "p",
        'р' => "r",
        'с' => "s",
        'т' => "t",
        'у' => "u",
        'ф' => "f",
        'х' => "kh",
        'ц' => "ts",
        'ч' => "ch",
        'ш' => "sh",
        'щ' => "shch",
        'ъ' | 'ь' => "",
        'ю' => "yu",
        'я' => "ya",
        _ => return None,
    })
}

fn is_greek_or_cyrillic(c: char) -> bool {
    matches!(c as u32, 0x0370..=0x03FF | 0x1F00..=0x1FFF | 0x0400..=0x04FF)
}

/// A Latin letter without its accent (the common ones; others pass through).
fn unaccent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'č' | 'ć' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ś' | 'š' | 'ş' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        'ł' => 'l',
        'ř' => 'r',
        'ť' => 't',
        'ď' => 'd',
        'ğ' => 'g',
        // Greek accents: capitals are written without them.
        'ά' => 'α',
        'έ' => 'ε',
        'ή' => 'η',
        'ί' | 'ϊ' | 'ΐ' => 'ι',
        'ό' => 'ο',
        'ύ' | 'ϋ' | 'ΰ' => 'υ',
        'ώ' => 'ω',
        _ => c,
    }
}

/// The raw text without its reference tails: a `*` part that carries digits
/// ("WOLT*ORDER 128" → "WOLT"), a `#…` reference, and trailing words that carry digits.
/// The case and letters are kept, so this also makes a payee's display name.
fn without_tails(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    // "MERCHANT*REF": cut at the first `*` whose remainder holds a digit, unless that leaves
    // nothing.
    if let Some(at) = text.find('*') {
        let (head, tail) = text.split_at(at);
        if tail.chars().any(|c| c.is_ascii_digit()) && head.chars().any(char::is_alphabetic) {
            text = head.to_string();
        }
    }
    let mut words: Vec<&str> = text.split_whitespace().collect();
    // Trailing references: `#4471`, `128`, `A1B2C3`; a glued run of three digits or more.
    while words.len() > 1 {
        let last = words[words.len() - 1];
        let is_ref = last.starts_with('#')
            || last.chars().any(|c| c.is_ascii_digit())
            || last.chars().all(|c| !c.is_alphanumeric());
        if !is_ref {
            break;
        }
        words.pop();
    }
    // A run of three digits or more inside the text is a reference too ("Card 1234 Corner Cafe").
    if words.iter().any(|w| !(w.len() >= 3 && w.chars().all(|c| c.is_ascii_digit()))) {
        words.retain(|w| !(w.len() >= 3 && w.chars().all(|c| c.is_ascii_digit())));
    }
    let mut out = words.join(" ");
    let digits = out.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits >= 3 && out.chars().filter(|c| c.is_alphabetic()).count() >= 3 {
        out.truncate(out.len() - digits);
    }
    if let Some(at) = out.find('#') {
        if out[..at].chars().any(char::is_alphabetic) {
            out.truncate(at);
        }
    }
    out.trim_end_matches(|c: char| !c.is_alphanumeric()).trim().to_string()
}

/// One word with the letters of another script read as Latin, when most of its letters are
/// Latin; else as it is.
fn fold_mixed_word(word: &str) -> String {
    let latin = word.chars().filter(|c| c.is_ascii_alphabetic() || ('\u{00C0}'..='\u{024F}').contains(c)).count();
    let other = word.chars().filter(|c| is_greek_or_cyrillic(*c)).count();
    if other == 0 || latin == 0 || latin < other {
        return word.to_string();
    }
    let mut out = String::with_capacity(word.len());
    for c in word.chars() {
        match is_greek_or_cyrillic(c).then(|| look_alike(c)).flatten() {
            Some(s) if c.is_uppercase() => out.push_str(&s.to_uppercase()),
            Some(s) => out.push_str(s),
            None => out.push(c),
        }
    }
    out
}

/// A raw payee's display name: the reference tails dropped, stray letters of another script
/// read as Latin, and a name in all capitals title-cased ([`title_case`]): "WOLT*ORDER 128" is
/// "Wolt", "CORNER BAKERY" is "Corner Bakery".
pub fn display_name(raw: &str) -> String {
    let name = without_tails(raw).split_whitespace().map(fold_mixed_word).collect::<Vec<_>>().join(" ");
    title_case(if name.is_empty() { raw.trim() } else { &name })
}

/// A name in all capitals, title-cased; any other name as it is. Words of three letters or
/// fewer ("KFC", "BP") and words with a digit or an ampersand ("H&M", "7ELEVEN") stay.
pub fn title_case(name: &str) -> String {
    let has_lower = name.chars().any(char::is_lowercase);
    if has_lower || !name.chars().any(char::is_uppercase) {
        return name.to_string();
    }
    name.split(' ')
        .map(|w| {
            let letters = w.chars().filter(|c| c.is_alphabetic()).count();
            if letters <= 3 || w.chars().any(|c| c.is_ascii_digit() || c == '&') {
                return w.to_string();
            }
            let lower = w.to_lowercase();
            match lower.char_indices().find(|(_, c)| c.is_alphabetic()) {
                Some((at, c)) => format!("{}{}{}", &lower[..at], c.to_uppercase(), &lower[at + c.len_utf8()..]),
                None => lower,
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words of a name, lower case, accents and punctuation dropped (an apostrophe joins).
fn words(name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for w in name.split(|c: char| c.is_whitespace()) {
        let w = fold_mixed_word(w);
        let mut cur = String::new();
        for c in w.chars().flat_map(char::to_lowercase) {
            let c = if c == 'ς' { 'σ' } else { unaccent(c) };
            if c.is_alphanumeric() {
                cur.push(c);
            } else if c == '\'' || c == '’' {
                // An apostrophe joins: "Mc'Brody's".
            } else if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

/// Company legal-form endings, as words (dots and spaces split them: "s.r.o." is `s r o`).
const LEGAL_FORMS: &[&[&str]] = &[
    &["ltd"],
    &["limited"],
    &["llc"],
    &["l", "l", "c"],
    &["inc"],
    &["incorporated"],
    &["corp"],
    &["corporation"],
    &["plc"],
    &["gmbh"],
    &["ag"],
    &["kg"],
    &["ohg"],
    &["ug"],
    &["sa"],
    &["s", "a"],
    &["sas"],
    &["sarl"],
    &["srl"],
    &["s", "r", "l"],
    &["spa"],
    &["s", "p", "a"],
    &["bv"],
    &["b", "v"],
    &["nv"],
    &["n", "v"],
    &["ab"],
    &["as"],
    &["asa"],
    &["oy"],
    &["oyj"],
    &["aps"],
    &["a", "s"],
    &["s", "r", "o"],
    &["sro"],
    &["d", "o", "o"],
    &["doo"],
    &["sp", "z", "o", "o"],
    &["ae"],
    &["epe"],
    &["ike"],
    &["oe"],
    &["ee"],
    &["pty"],
    &["pty", "ltd"],
    &["co"],
    &["co", "ltd"],
    &["lp"],
    &["llp"],
    &["sl"],
    &["slu"],
    &["kft"],
    &["zrt"],
    &["sia"],
    &["uab"],
    &["ou"],
    &["as"],
];

/// The certain key: two raw texts with the same key are one payee, without asking. Empty
/// when the text has no letters or digits. A company's legal-form ending is dropped when
/// something is left ("Delta Kiosk Ltd" is "Delta Kiosk").
pub fn certain_key(raw: &str) -> String {
    let mut w = words(&without_tails(raw));
    loop {
        let ending = LEGAL_FORMS
            .iter()
            .filter(|f| f.len() < w.len() && w[w.len() - f.len()..].iter().zip(f.iter()).all(|(a, b)| a == b))
            .map(|f| f.len())
            .max();
        match ending {
            Some(n) => w.truncate(w.len() - n),
            None => break,
        }
    }
    w.join(" ")
}

/// Filler words a merchant's text carries that don't tell two payees apart.
const FILLER: &[&str] = &[
    "order", "orders", "payment", "payments", "pay", "purchase", "online", "ltd", "limited", "inc", "gmbh", "sa", "ae",
    "ike", "oe", "epe", "co", "com", "www", "the", "bv", "llc", "plc", "sas", "srl", "spa", "card", "pos", "ref",
];

/// The loose key: the certain key with every Greek and Cyrillic letter transliterated and
/// filler words dropped. Equal loose keys are a suggestion, never a merge.
pub fn loose_key(raw: &str) -> String {
    let certain = certain_key(raw);
    let mut kept: Vec<String> = Vec::new();
    for w in certain.split(' ') {
        let t: String = w.chars().map(|c| phonetic(c).map(str::to_string).unwrap_or_else(|| c.to_string())).collect();
        if !t.is_empty() && !FILLER.contains(&t.as_str()) {
            kept.push(t);
        }
    }
    if kept.is_empty() {
        certain
    } else {
        kept.join(" ")
    }
}

/// Levenshtein distance over chars, giving up past `max`.
fn distance_within(a: &str, b: &str, max: usize) -> Option<usize> {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > max {
        return None;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        if cur.iter().min().is_some_and(|m| *m > max) {
            return None;
        }
        prev = cur;
    }
    (prev[b.len()] <= max).then_some(prev[b.len()])
}

/// Why two names look like one payee, or `None`. Works on loose keys ([`loose_key`]).
pub fn similar(a: &str, b: &str) -> Option<&'static str> {
    if a.is_empty() || b.is_empty() || a == b {
        return (!a.is_empty() && a == b).then_some("same name");
    }
    let short = a.chars().count().min(b.chars().count());
    let max = if short >= 9 {
        2
    } else if short >= 5 {
        1
    } else {
        0
    };
    if max > 0 && distance_within(a, b, max).is_some() {
        return Some("spelled alike");
    }
    // A name of two words or more with a different last word: a branch or a city ("green
    // market athens", "green market patras"). One shared word is too little ("golden bakery",
    // "golden grill"), and a name that only adds a word ("bolt", "bolt food") can be another
    // shop.
    let (wa, wb): (Vec<&str>, Vec<&str>) = (a.split(' ').collect(), b.split(' ').collect());
    if wa.len() == wb.len() && wa.len() >= 3 && wa[..wa.len() - 1] == wb[..wb.len() - 1] {
        return Some("another branch");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certain_keys_fold_spellings_of_one_payee() {
        for (raw, key) in [
            ("WOΛT", "wolt"),
            ("Wolt", "wolt"),
            ("WOLT*ORDER 128", "wolt"),
            ("wolt.", "wolt"),
            ("Green Market #4471", "green market"),
            ("GREEN MARKET 0042", "green market"),
            ("Green-Market", "green market"),
            ("SPOTIFY P1A2B3C4", "spotify"),
            ("Netflix.com 123456", "netflix com"),
            ("Café Lumen", "cafe lumen"),
            ("CAFE LUMEN", "cafe lumen"),
            ("Mc'Brody's", "mcbrodys"),
            ("PAYPAL *TUNEHUB", "paypal tunehub"),
            ("ZΑPPO", "zappo"),      // a Greek capital alpha
            ("ТRAMLY 22", "tramly"), // a Cyrillic capital te
            ("Kebab 24", "kebab"),
            ("Card 1234 Corner Cafe", "card corner cafe"),
            ("Delta Kiosk Ltd", "delta kiosk"),
            ("DELTA KIOSK LTD.", "delta kiosk"),
            ("Delta Kiosk Sp. z o.o.", "delta kiosk"),
            ("Delta Kiosk s.r.o.", "delta kiosk"),
            ("Delta Kiosk Co. Ltd", "delta kiosk"),
            ("Delta Kiosk GmbH & Co KG", "delta kiosk"),
            ("Ltd", "ltd"),
            ("Route 66 Diner", "route 66 diner"),
            ("", ""),
            ("12345", "12345"),
        ] {
            assert_eq!(certain_key(raw), key, "{raw}");
        }
    }

    #[test]
    fn a_name_in_another_script_stays_itself() {
        // All-Greek and all-Cyrillic words are names in their own script, not typos.
        assert_eq!(certain_key("ΦΟΥΡΝΟΣ ΑΣΤΕΡΙ"), "φουρνοσ αστερι");
        assert_eq!(certain_key("Φούρνος Αστέρι"), "φουρνοσ αστερι");
        assert_eq!(certain_key("МАГАЗИН ЛУНА"), "магазин луна");
        assert_ne!(certain_key("ΦΟΥΡΝΟΣ ΑΣΤΕΡΙ"), certain_key("Fournos Asteri"));
        // The loose key reads them by sound, so the Latin spelling is suggested.
        assert_eq!(loose_key("ΦΟΥΡΝΟΣ ΑΣΤΕΡΙ"), "foyrnos asteri");
        assert_eq!(loose_key("МАГАЗИН ЛУНА"), "magazin luna");
        assert_eq!(similar(&loose_key("ΦΟΥΡΝΟΣ ΑΣΤΕΡΙ"), &loose_key("Fournos Asteri")), Some("spelled alike"));
    }

    #[test]
    fn display_names_drop_tails_and_stray_letters() {
        for (raw, name) in [
            ("WOLT*ORDER 128", "Wolt"),
            ("WOΛT", "Wolt"),
            ("Green Market #4471", "Green Market"),
            ("PAYPAL *TUNEHUB", "Paypal *Tunehub"),
            ("  Bolt  ", "Bolt"),
            ("CORNER BAKERY", "Corner Bakery"),
            ("KFC ATHENS", "KFC Athens"),
            ("H&M STORE 22", "H&M Store"),
            ("7ELEVEN MARKET", "7ELEVEN Market"),
            ("ΦΟΥΡΝΟΣ ΑΣΤΕΡΙ", "Φουρνος Αστερι"),
            ("McBrody's", "McBrody's"),
            ("eBay", "eBay"),
        ] {
            assert_eq!(display_name(raw), name, "{raw}");
        }
    }

    #[test]
    fn loose_keys_suggest_but_never_merge() {
        // "Wolt order" isn't certainly Wolt, but it's suggested.
        assert_ne!(certain_key("WOLT ORDER"), certain_key("Wolt"));
        assert_eq!(loose_key("WOLT ORDER"), loose_key("Wolt"));
        assert_eq!(similar(&loose_key("WOLT ORDER"), &loose_key("Wolt")), Some("same name"));
        // A typo.
        assert_eq!(similar(&loose_key("Starbrew"), &loose_key("Starbew")), Some("spelled alike"));
        assert_eq!(similar(&loose_key("Lumen Bakery"), &loose_key("Lumen Bakkery")), Some("spelled alike"));
    }

    #[test]
    fn different_shops_stay_apart() {
        // A name that is a prefix of another shop's.
        for (a, b) in [("Bolt", "Bolt Food"), ("Lidl", "Lidl Plus"), ("Bar", "Barista Co"), ("Uber", "Uber Eats")] {
            assert_ne!(certain_key(a), certain_key(b), "{a} / {b}");
            assert_eq!(similar(&loose_key(a), &loose_key(b)), None, "{a} / {b}");
        }
        // Short names one letter apart are different shops.
        assert_eq!(similar(&loose_key("Bolt"), &loose_key("Bold")), None);
        assert_eq!(similar(&loose_key("Spar"), &loose_key("Star")), None);
    }

    #[test]
    fn names_that_differ_by_a_city_are_suggested() {
        assert_ne!(certain_key("Lumen Bakery Athens"), certain_key("Lumen Bakery Patras"));
        assert_eq!(
            similar(&loose_key("Lumen Bakery Athens"), &loose_key("Lumen Bakery Patras")),
            Some("another branch")
        );
        // One shared word is too little to go on: two shops of a street, or a brand's two
        // services.
        assert_eq!(similar(&loose_key("Golden Bakery"), &loose_key("Golden Grill")), None);
        assert_eq!(similar(&loose_key("Bolt Food"), &loose_key("Bolt Taxi")), None);
    }
}
