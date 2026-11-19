//! End-to-end parsing tests on synthetic files (made-up payees and amounts): the
//! mapping wizard, and the registry of built-in formats on the tests' made-up one.

use super::*;
use chrono::NaiveDate;

fn d(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

const SAMPLE: &str = "Kind,Account,Time,Booked,Text,Amount,Fee,Currency,Balance,Other,Fx\n\
    card,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Green  Market,-14.76,0.00,EUR,985.24,,\n\
    transfer,Current,2026-10-02 09:00:00,2026-10-02 09:00:00,To Holiday,-50.00,0.00,EUR,935.24,Holiday,\n\
    exchange,Current,,2026-10-03,Exchanged to GBP,-10.00,0.10,EUR,,,GBP\n\
    card,Current,,2026-10-04,Broken,not money,0.00,EUR,,,\n";

#[test]
fn a_built_in_format_is_detected_and_read() {
    let r = parse(SAMPLE.as_bytes(), None).unwrap();
    assert_eq!((r.profile_key.as_deref(), r.format), (Some("sample"), Format::Csv));
    assert!(r.confidence > 0.5);
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.warnings, ["row 5 skipped: no readable date, amount or currency"]);
    let card = &r.rows[0];
    assert_eq!((card.booked_date, card.amount_minor, card.balance_minor), (d("2026-10-01"), -1476, Some(98_524)));
    assert_eq!(card.occurred_at.map(|t| t.to_string()).as_deref(), Some("2026-10-01 09:00:00"));
    assert_eq!((card.description.as_str(), card.payee.as_deref()), ("Green Market", Some("Green Market")));
    let pocket = &r.rows[1];
    assert_eq!(pocket.kind_hint, Some(KindHint::Transfer));
    assert_eq!(pocket.counterpart_guess.as_deref(), Some("sample:holiday:EUR"));
    let fx = &r.rows[2];
    assert_eq!((fx.fee_minor, fx.fx_currency.as_deref(), fx.occurred_at), (10, Some("GBP"), None));
    let keys: Vec<&str> = r.accounts.iter().map(|a| a.guess_key.as_str()).collect();
    // The exchange leg's other side: the same account in the other currency.
    assert_eq!(keys, ["sample:current:EUR", "sample:holiday:EUR", "sample:current:GBP"]);
    assert_eq!(fx.counterpart_guess.as_deref(), Some("sample:current:GBP"));
    assert_eq!((r.accounts[1].kind.as_str(), r.accounts[2].kind.as_str()), ("savings", "current"));
}

#[test]
fn unknown_layout_returns_a_sample_for_the_wizard() {
    let csv = "My Bank export\n\nDatum;Text;Soll;Haben;Saldo\n05.10.2026;Bakery;3,20;;96,80\n06.10.2026;Salary;;1.000,00;1.096,80\n";
    let r = parse(csv.as_bytes(), None).unwrap();
    assert_eq!(r.profile_key, None);
    assert_eq!(r.confidence, 0.0);
    assert!(r.rows.is_empty());
    assert_eq!(r.sample[0], vec!["My Bank export"]);
    assert_eq!(r.sample[1], vec!["Datum", "Text", "Soll", "Haben", "Saldo"]);

    // The wizard's mapping reads it: header after a preamble, debit/credit, d.m.Y.
    let mapping: Mapping = serde_json::from_value(serde_json::json!({
        "bookedDate": "Datum",
        "description": ["Text"],
        "debit": "Soll",
        "credit": "Haben",
        "balance": "Saldo",
        "decimal": "comma",
        "accountName": "Example Bank",
        "institution": "Example"
    }))
    .unwrap();
    let spec = ProfileSpec::Mapping { key: "user:example".into(), mapping };
    let r = parse(csv.as_bytes(), Some(&spec)).unwrap();
    assert_eq!(r.profile_key.as_deref(), Some("user:example"));
    assert_eq!(r.confidence, 1.0);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0].booked_date, d("2026-10-05"));
    assert_eq!(r.rows[0].amount_minor, -320);
    assert_eq!(r.rows[1].amount_minor, 100_000);
    assert_eq!(r.rows[1].balance_minor, Some(109_680));
    assert_eq!(r.rows[1].currency, "EUR");
    assert_eq!(r.accounts[0].guess_key, "user:example:example bank:EUR");
}

#[test]
fn mapping_by_index_with_inverted_sign_and_date_format() {
    let csv = "date,what,amount,cur\n10/05/2026,Book shop,25.00,GBP\n";
    let mapping = Mapping {
        booked_date: Some(ColRef::Index(0)),
        description: vec![ColRef::Index(1)],
        amount: Some(ColRef::Index(2)),
        currency: Some(ColRef::Name("cur".into())),
        date_format: Some("%m/%d/%Y".into()),
        invert_sign: true,
        account_kind: Some("card".into()),
        ..Default::default()
    };
    let r = parse(csv.as_bytes(), Some(&ProfileSpec::Mapping { key: "card".into(), mapping })).unwrap();
    assert_eq!(r.rows[0].booked_date, d("2026-10-05"));
    assert_eq!(r.rows[0].amount_minor, -2500);
    assert_eq!(r.rows[0].currency, "GBP");
    assert_eq!(r.accounts[0].kind, "card");
}

#[test]
fn mapping_validation() {
    let ok = Mapping {
        booked_date: Some(ColRef::Index(0)),
        description: vec![ColRef::Index(1)],
        amount: Some(ColRef::Index(2)),
        ..Default::default()
    };
    assert!(ok.validate().is_ok());
    assert!(Mapping { booked_date: None, ..ok.clone() }.validate().is_err());
    assert!(Mapping { description: vec![], ..ok.clone() }.validate().is_err());
    assert!(Mapping { amount: None, ..ok.clone() }.validate().is_err());
    assert!(Mapping { currency_default: Some("euro".into()), ..ok.clone() }.validate().is_err());
    assert!(Mapping { account_kind: Some("vault".into()), ..ok.clone() }.validate().is_err());
}

#[test]
fn oversized_and_broken_files_are_refused() {
    assert!(read_grid(&vec![b'a'; MAX_FILE_BYTES + 1]).unwrap_err().is_invalid_input());
    assert!(read_grid(b"PK\x03\x04 not really a zip").unwrap_err().is_invalid_input());
}

#[test]
fn outputs_are_snake_case() {
    let r = parse(SAMPLE.as_bytes(), None).unwrap();
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!((v["profile_key"].as_str(), v["format"].as_str()), (Some("sample"), Some("csv")));
    let row = &v["rows"][0];
    assert_eq!(row["booked_date"], "2026-10-01");
    assert_eq!(row["amount_minor"], -1476);
    assert_eq!(row["kind_hint"], "card");
    assert_eq!(row["account_guess"], "sample:current:EUR");
    assert_eq!(v["accounts"][0]["guess_key"], "sample:current:EUR");
    assert!(v["accounts"][0].get("matched_account_id").is_none());
}

#[test]
fn the_registry_lists_and_finds_built_in_formats() {
    let keys: Vec<&str> = builtin_profiles().iter().map(|p| p.key).collect();
    assert!(keys.contains(&"sample"), "{keys:?}");
    assert_eq!(ProfileSpec::builtin("sample"), Some(ProfileSpec::Builtin(&profiles::sample::FORMAT)));
    assert_eq!(ProfileSpec::builtin("nope"), None);
    // A chosen built-in format must match the file.
    let other = "date,what,amount\n2026-10-01,Tea,-2.00\n";
    assert!(parse(other.as_bytes(), ProfileSpec::builtin("sample").as_ref()).unwrap_err().is_invalid_input());
}

#[test]
fn a_profile_key_this_build_doesnt_have_is_not_built_in() {
    // Lines and accounts imported by a build with a format this one lacks keep its key;
    // here the key just isn't built in, and the file goes to the wizard.
    assert_eq!(ProfileSpec::builtin("some-bank-format"), None);
    let r = parse(b"Posted,Memo,Value\n2026-10-01,Tea,-2.00\n", None).unwrap();
    assert_eq!((r.profile_key, r.rows.len()), (None, 0));
    assert_eq!(r.sample[0], ["Posted", "Memo", "Value"]);
}

#[test]
fn the_wizard_guesses_the_columns_from_their_names() {
    let csv = "My Bank export\n\nBooking date,Details,Counterparty,Money out,Money in,Balance,Currency\n\
               2026-10-01,Card,Corner Bakery,3.20,,96.80,EUR\n";
    let r = parse(csv.as_bytes(), None).unwrap();
    let m = r.suggested_mapping.expect("a guess");
    let name = |c: &Option<profiles::mapping::ColRef>| match c {
        Some(profiles::mapping::ColRef::Name(n)) => n.clone(),
        _ => String::new(),
    };
    assert_eq!(name(&m.booked_date), "Booking date");
    assert_eq!(m.description.len(), 1);
    assert_eq!(
        (name(&m.payee), name(&m.balance), name(&m.currency)),
        ("Counterparty".into(), "Balance".into(), "Currency".into())
    );
    assert_eq!((name(&m.debit), name(&m.credit), m.amount.is_none()), ("Money out".into(), "Money in".into(), true));
    // A signed amount column: no debit/credit pair.
    let r = parse("Date,Text,Amount\n2026-10-01,Bakery,-3.20\n".as_bytes(), None).unwrap();
    let m = r.suggested_mapping.unwrap();
    assert_eq!((name(&m.amount), m.debit.is_none()), ("Amount".into(), true));
    // Nothing date- or amount-like: no guess.
    assert!(parse("a,b\n1,2\n".as_bytes(), None).unwrap().suggested_mapping.is_none());
}
