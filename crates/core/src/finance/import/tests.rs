//! End-to-end parsing tests on synthetic files (made-up payees and amounts).

use super::*;
use rust_xlsxwriter::{Format as XFormat, Workbook};

/// A value written into a test spreadsheet.
enum V<'a> {
    S(&'a str),
    N(f64),
    /// A serial date with a date-time number format.
    D(f64),
    E,
}
use V::*;

fn xlsx(rows: &[Vec<V>]) -> Vec<u8> {
    let mut book = Workbook::new();
    let sheet = book.add_worksheet();
    let date = XFormat::new().set_num_format("yyyy-mm-dd hh:mm:ss");
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            let (r, c) = (r as u32, c as u16);
            match v {
                S(s) => {
                    sheet.write_string(r, c, *s).unwrap();
                }
                N(n) => {
                    sheet.write_number(r, c, *n).unwrap();
                }
                D(n) => {
                    sheet.write_number_with_format(r, c, *n, &date).unwrap();
                }
                E => {}
            }
        }
    }
    book.save_to_buffer().unwrap()
}

fn d(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

const REVOLUT_HEADER: [&str; 10] =
    ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"];

fn revolut_row<'a>(
    typ: &'a str,
    product: &'a str,
    started: f64,
    completed: Option<f64>,
    desc: &'a str,
    amount: f64,
    fee: f64,
    cur: &'a str,
    state: &'a str,
) -> Vec<V<'a>> {
    vec![
        S(typ),
        S(product),
        D(started),
        completed.map(D).unwrap_or(E),
        S(desc),
        N(amount),
        N(fee),
        S(cur),
        S(state),
        N(100.0),
    ]
}

/// 46296 is 2026-10-01.
fn revolut_file() -> Vec<u8> {
    let mut rows = vec![REVOLUT_HEADER.iter().map(|h| S(h)).collect::<Vec<_>>()];
    rows.extend([
        // UTF-8 "WOΛT" that went through cp1252.
        revolut_row("Card Payment", "Current", 46295.8, Some(46296.5), "WOÎ›T", -14.76, 0.0, "EUR", "COMPLETED"),
        revolut_row("Card Payment", "Current", 46296.1, None, "Corner Shop", -3.0, 0.0, "EUR", "PENDING"),
        revolut_row("Card Payment", "Current", 46296.2, Some(46296.3), "Corner Shop", -3.0, 0.0, "EUR", "REVERTED"),
        revolut_row("Transfer", "Current", 46296.8, Some(46296.8), "From EUR ðŸ’¸ Bills", 30.0, 0.0, "EUR", "COMPLETED"),
        revolut_row("Transfer", "Current", 46297.0, Some(46297.0), "To EUR Holiday", -50.0, 0.0, "EUR", "COMPLETED"),
        revolut_row("Exchange", "Current", 46297.25, Some(46297.25), "Exchanged to GBP", -10.0, 0.0, "EUR", "COMPLETED"),
        revolut_row("Exchange", "Current", 46297.25, Some(46297.25), "Exchanged to GBP", 8.61, 0.0, "GBP", "COMPLETED"),
        revolut_row("Card Payment", "Current", 46297.4, Some(46297.5), "Faraway Store", -20.0, 0.5, "EUR", "COMPLETED"),
        revolut_row("Fee", "Current", 46297.6, Some(46297.6), "Plan fee", -7.99, 0.0, "EUR", "COMPLETED"),
        revolut_row("Reward", "Savings", 46298.5, Some(46298.5), "Savings: interest", 0.42, 0.0, "EUR", "COMPLETED"),
        revolut_row("Transfer", "Current", 46298.6, Some(46298.6), "To Alex Example", -12.0, 0.0, "EUR", "COMPLETED"),
    ]);
    xlsx(&rows)
}

#[test]
fn revolut_xlsx_named_csv_is_sniffed_by_content() {
    let r = parse(&revolut_file(), None).unwrap();
    assert_eq!(r.format, Format::Xlsx);
    assert_eq!(r.profile_key.as_deref(), Some("revolut"));
    assert!(r.confidence > 0.9);
    assert_eq!(r.header[0], "Type");
}

#[test]
fn revolut_rows() {
    let r = parse(&revolut_file(), None).unwrap();
    // COMPLETED only: the PENDING and REVERTED rows are skipped with a warning.
    assert_eq!(r.rows.len(), 9);
    assert!(r.warnings.iter().any(|w| w.contains("2 rows skipped as not completed")));
    assert!(r.warnings.iter().all(|w| !w.contains("Corner")), "warnings never quote the file");

    let card = &r.rows[0];
    assert_eq!(card.line, 2);
    assert_eq!(card.description, "WOΛT", "mojibake repaired");
    assert_eq!(card.payee.as_deref(), Some("WOΛT"));
    assert_eq!(card.amount_minor, -1476);
    assert_eq!(card.booked_date, d("2026-10-01"), "booked on Completed");
    assert_eq!(card.value_date, Some(d("2026-09-30")), "value date is Started");
    assert_eq!(card.booked_at.unwrap().format("%H:%M").to_string(), "12:00");
    assert_eq!(card.kind_hint, Some(KindHint::Card));
    assert_eq!(card.account_guess, "revolut:current:EUR");
    assert_eq!(card.balance_minor, Some(10_000));
    assert_eq!(card.raw["Description"], "WOΛT");

    // Pocket moves name the pocket as the counterpart, created as a savings guess.
    let from = &r.rows[1];
    assert_eq!(from.description, "From EUR 💸 Bills");
    assert_eq!(from.kind_hint, Some(KindHint::Transfer));
    assert_eq!(from.counterpart_guess.as_deref(), Some("revolut:pocket:💸 bills:EUR"));
    assert_eq!(from.payee, None);
    let to = &r.rows[2];
    assert_eq!(to.amount_minor, -5000);
    assert_eq!(to.counterpart_guess.as_deref(), Some("revolut:pocket:holiday:EUR"));
    let pocket = r.accounts.iter().find(|a| a.guess_key == "revolut:pocket:holiday:EUR").unwrap();
    assert_eq!((pocket.name.as_str(), pocket.kind.as_str()), ("Holiday", "savings"));

    // "Exchanged to" legs: the EUR leg names GBP; the GBP leg sits in a GBP account.
    let eur_leg = &r.rows[3];
    assert_eq!(eur_leg.kind_hint, Some(KindHint::Exchange));
    assert_eq!(eur_leg.fx_currency.as_deref(), Some("GBP"));
    let gbp_leg = &r.rows[4];
    assert_eq!(gbp_leg.currency, "GBP");
    assert_eq!(gbp_leg.amount_minor, 861);
    assert_eq!(gbp_leg.fx_currency, None);
    assert_eq!(gbp_leg.account_guess, "revolut:current:GBP");
    assert_eq!(eur_leg.booked_at, gbp_leg.booked_at);

    // Fee column, a Fee row, and a Reward.
    assert_eq!(r.rows[5].fee_minor, 50);
    assert_eq!(r.rows[5].amount_minor, -2000);
    assert_eq!(r.rows[6].kind_hint, Some(KindHint::Fee));
    let reward = &r.rows[7];
    assert_eq!(reward.kind_hint, Some(KindHint::Interest));
    assert_eq!(reward.account_guess, "revolut:savings:EUR");

    // A transfer to a person is not a pocket move.
    let p2p = &r.rows[8];
    assert_eq!(p2p.counterpart_guess, None);
    assert_eq!(p2p.payee.as_deref(), Some("Alex Example"));

    let keys: Vec<&str> = r.accounts.iter().map(|a| a.guess_key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "revolut:current:EUR",
            "revolut:pocket:💸 bills:EUR",
            "revolut:pocket:holiday:EUR",
            "revolut:current:GBP",
            "revolut:savings:EUR"
        ]
    );
    let savings = r.accounts.iter().find(|a| a.guess_key == "revolut:savings:EUR").unwrap();
    assert_eq!(savings.kind, "savings");
}

#[test]
fn revolut_csv_text_dates() {
    let csv = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\r\n\
               Card Payment,Current,2026-10-01 09:15:00,2026-10-02 10:00:00,Tiny Café,-4.50,0.00,EUR,COMPLETED,95.50\r\n\
               Card Payment,Current,2026-10-03 09:15:00,,Tiny Café,-1.00,0.00,EUR,PENDING,\r\n";
    let r = parse(csv.as_bytes(), None).unwrap();
    assert_eq!(r.format, Format::Csv);
    assert_eq!(r.profile_key.as_deref(), Some("revolut"));
    assert_eq!(r.rows.len(), 1);
    let row = &r.rows[0];
    assert_eq!(row.booked_date, d("2026-10-02"));
    assert_eq!(row.value_date, Some(d("2026-10-01")));
    assert_eq!(row.description, "Tiny Café");
    assert_eq!(row.amount_minor, -450);
    assert_eq!(row.balance_minor, Some(9550));
}

#[test]
fn revolut_unreadable_amount_is_skipped_by_line() {
    let rows = vec![
        REVOLUT_HEADER.iter().map(|h| S(h)).collect::<Vec<_>>(),
        vec![S("Reward"), S("Current"), D(46297.5), D(46297.5), S("Interest"), S("xx.xx"), N(0.0), S("EUR"), S("COMPLETED"), S("xx.xx")],
    ];
    let r = parse(&xlsx(&rows), None).unwrap();
    assert!(r.rows.is_empty());
    assert_eq!(r.warnings, vec!["row 2 skipped: no readable date, amount or currency"]);
}

fn piraeus_file() -> Vec<u8> {
    xlsx(&[
        vec![S("Piraeus Bank")],
        vec![S("Account Transactions")],
        vec![],
        vec![S("BASIC SAVINGS ACC R:  GR16 0110 1250 0000 0001 2300 695")],
        vec![S("Selected Period: 01/11/2026 - 04/11/2026")],
        vec![],
        vec![
            S("Category"),
            S("Transaction Details"),
            S("Transaction Date"),
            S("Transaction Comments / Reference Code"),
            S("Amount"),
            S("Currency"),
            S("Progressive Ledger Balance"),
            S("Currency"),
        ],
        vec![
            S("Obligations / Bank fees\u{a0}"),
            S("COMMISSION                    "),
            S("02/11/2026"),
            S("ΑΝΑΝΕΩΣΗ ΧΡΕΩΣΤΙΚΗΣ ΚΑΡΤΑΣ\nREF 0001 / FE0001"),
            N(-6.0),
            S("EUR"),
            S("1.234,56"),
            S("EUR"),
        ],
        vec![
            S("Income / Transfers"),
            S("ΜΕΤΑΦΟΡΑ ΑΠΟ ΛΟΓΑΡΙΑΣΜΟ"),
            S("03/11/2026"),
            E,
            S("1.500,00"),
            S("EUR"),
            S("2.734,56"),
            S("EUR"),
        ],
        vec![],
        vec![],
        vec![S("Update Date:"), S("04/11/2026 12:10:32")],
    ])
}

#[test]
fn piraeus_preamble_greek_and_decimal_commas() {
    let r = parse(&piraeus_file(), None).unwrap();
    assert_eq!(r.profile_key.as_deref(), Some("piraeus"));
    assert!(r.confidence > 0.95, "the preamble names the bank");
    assert_eq!(r.rows.len(), 2, "the footer is not a row");
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);

    let fee = &r.rows[0];
    assert_eq!(fee.line, 8);
    assert_eq!(fee.booked_date, d("2026-11-02"));
    assert_eq!(fee.amount_minor, -600);
    assert_eq!(fee.balance_minor, Some(123_456));
    assert_eq!(fee.description, "COMMISSION — ΑΝΑΝΕΩΣΗ ΧΡΕΩΣΤΙΚΗΣ ΚΑΡΤΑΣ", "Greek kept as it is");
    assert_eq!(fee.bank_category.as_deref(), Some("Obligations / Bank fees"));
    assert_eq!(fee.kind_hint, Some(KindHint::Fee));
    assert_eq!(fee.raw["Currency 2"], "EUR");

    let transfer = &r.rows[1];
    assert_eq!(transfer.amount_minor, 150_000);
    assert_eq!(transfer.kind_hint, Some(KindHint::Transfer));
    assert_eq!(transfer.description, "ΜΕΤΑΦΟΡΑ ΑΠΟ ΛΟΓΑΡΙΑΣΜΟ");

    assert_eq!(r.accounts.len(), 1);
    let a = &r.accounts[0];
    assert_eq!(a.guess_key, "piraeus:0695:EUR");
    assert_eq!(a.name, "BASIC SAVINGS ACC");
    assert_eq!(a.kind, "savings");
    assert_eq!(a.iban_mask.as_deref(), Some("GR•• … 0695"));
    assert_eq!(a.institution.as_deref(), Some("Piraeus Bank"));
}

#[test]
fn piraeus_csv_in_greek_code_page() {
    // cp1253, semicolons, decimal commas.
    let mut bytes = b"Piraeus Bank\r\nACC: GR16 0110 1250 0000 0001 2300 695\r\n\r\n".to_vec();
    bytes.extend_from_slice(
        b"Category;Transaction Details;Transaction Date;Transaction Comments / Reference Code;Amount;Currency;Progressive Ledger Balance;Currency\r\n",
    );
    // "ΑΓΟΡΑ" (purchase) in cp1253.
    bytes.extend_from_slice(b"Shopping;\xc1\xc3\xcf\xd1\xc1;01/11/2026;;-12,30;EUR;987,70;EUR\r\n");
    let r = parse(&bytes, None).unwrap();
    assert_eq!(r.profile_key.as_deref(), Some("piraeus"));
    let row = &r.rows[0];
    assert_eq!(row.description, "ΑΓΟΡΑ");
    assert_eq!(row.amount_minor, -1230);
    assert_eq!(row.balance_minor, Some(98_770));
    assert_eq!(row.kind_hint, Some(KindHint::Card));
    assert_eq!(r.accounts[0].kind, "current");
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
fn chosen_profile_must_match_the_file() {
    let err = parse(&piraeus_file(), Some(&ProfileSpec::Revolut)).unwrap_err();
    assert!(err.is_invalid_input());
}

#[test]
fn oversized_and_broken_files_are_refused() {
    assert!(read_grid(&vec![b'a'; MAX_FILE_BYTES + 1]).unwrap_err().is_invalid_input());
    assert!(read_grid(b"PK\x03\x04 not really a zip").unwrap_err().is_invalid_input());
}

#[test]
fn outputs_are_snake_case() {
    let r = parse(&revolut_file(), None).unwrap();
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["profile_key"], "revolut");
    assert_eq!(v["format"], "xlsx");
    let row = &v["rows"][0];
    assert_eq!(row["booked_date"], "2026-10-01");
    assert_eq!(row["amount_minor"], -1476);
    assert_eq!(row["kind_hint"], "card");
    assert_eq!(row["account_guess"], "revolut:current:EUR");
    assert_eq!(v["accounts"][0]["guess_key"], "revolut:current:EUR");
    assert!(v["accounts"][0].get("matched_account_id").is_none());
}

#[test]
fn builtin_profiles_are_listed() {
    let keys: Vec<&str> = builtin_profiles().iter().map(|p| p.key).collect();
    assert_eq!(keys, ["revolut", "piraeus"]);
    assert_eq!(ProfileSpec::builtin("piraeus"), Some(ProfileSpec::Piraeus));
    assert_eq!(ProfileSpec::builtin("nope"), None);
}
