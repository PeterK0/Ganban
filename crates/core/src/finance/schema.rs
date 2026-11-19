//! The finance tables (`docs/design/FINANCE.md` § Data). Host-only: none of them is in the
//! sync engine's captured or synced lists, so they never reach an offline replica.

use sqlx::SqlitePool;

use crate::error::Result;

const TABLES: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS fin_entities (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        user_id INTEGER NOT NULL UNIQUE, \
        project_id INTEGER, \
        name TEXT NOT NULL, \
        functional_currency TEXT NOT NULL DEFAULT 'EUR', \
        created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS fin_ledger_accounts (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        code TEXT NOT NULL, \
        name TEXT NOT NULL, \
        class TEXT NOT NULL CHECK (class IN ('asset','liability','equity','income','expense')), \
        parent_id INTEGER REFERENCES fin_ledger_accounts(id) ON DELETE SET NULL, \
        currency TEXT, \
        cash_flow_class TEXT CHECK (cash_flow_class IN ('operating','investing','financing')), \
        system_key TEXT, \
        archived INTEGER NOT NULL DEFAULT 0, \
        position INTEGER NOT NULL DEFAULT 0)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_ledger_system ON fin_ledger_accounts(entity_id, system_key) \
        WHERE system_key IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_fin_ledger_entity ON fin_ledger_accounts(entity_id)",
    "CREATE TABLE IF NOT EXISTS fin_accounts (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        ledger_account_id INTEGER NOT NULL UNIQUE REFERENCES fin_ledger_accounts(id), \
        kind TEXT NOT NULL CHECK (kind IN ('current','savings','card','cash','loan')), \
        name TEXT NOT NULL, \
        institution TEXT, \
        currency TEXT NOT NULL, \
        iban_mask TEXT, \
        profile_key TEXT, \
        archived INTEGER NOT NULL DEFAULT 0, \
        created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_fin_accounts_entity ON fin_accounts(entity_id)",
    "CREATE TABLE IF NOT EXISTS fin_import_batches (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        file_name TEXT NOT NULL, \
        profile_key TEXT, \
        imported_at TEXT NOT NULL, \
        rows_total INTEGER NOT NULL DEFAULT 0, \
        rows_new INTEGER NOT NULL DEFAULT 0, \
        rows_duplicate INTEGER NOT NULL DEFAULT 0)",
    // `dismissed_at`: set when the entry built from the line is deleted. The line stays, so
    // a re-import still dedupes against it.
    "CREATE TABLE IF NOT EXISTS fin_source_lines (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        account_id INTEGER NOT NULL REFERENCES fin_accounts(id), \
        batch_id INTEGER REFERENCES fin_import_batches(id) ON DELETE SET NULL, \
        hash TEXT NOT NULL, \
        booked_date TEXT NOT NULL, \
        value_date TEXT, \
        description TEXT NOT NULL DEFAULT '', \
        payee TEXT, \
        amount_minor INTEGER NOT NULL, \
        currency TEXT NOT NULL, \
        fee_minor INTEGER NOT NULL DEFAULT 0, \
        balance_minor INTEGER, \
        bank_category TEXT, \
        kind_hint TEXT, \
        raw_json TEXT NOT NULL DEFAULT '{}', \
        dismissed_at TEXT, \
        created_at TEXT NOT NULL, \
        UNIQUE(entity_id, account_id, hash))",
    "CREATE TABLE IF NOT EXISTS fin_entries (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        date TEXT NOT NULL, \
        description TEXT NOT NULL DEFAULT '', \
        payee TEXT, \
        status TEXT NOT NULL CHECK (status IN ('draft','posted','reversed')), \
        source_line_id INTEGER UNIQUE REFERENCES fin_source_lines(id) ON DELETE SET NULL, \
        reverses_id INTEGER REFERENCES fin_entries(id) ON DELETE SET NULL, \
        notes TEXT, \
        created_at TEXT NOT NULL, \
        updated_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_fin_entries_entity_date ON fin_entries(entity_id, date)",
    "CREATE TABLE IF NOT EXISTS fin_lines (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entry_id INTEGER NOT NULL REFERENCES fin_entries(id) ON DELETE CASCADE, \
        ledger_account_id INTEGER NOT NULL REFERENCES fin_ledger_accounts(id), \
        amount_minor INTEGER NOT NULL, \
        currency TEXT NOT NULL, \
        functional_minor INTEGER NOT NULL, \
        rate REAL NOT NULL DEFAULT 1, \
        memo TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_fin_lines_entry ON fin_lines(entry_id)",
    "CREATE INDEX IF NOT EXISTS idx_fin_lines_account ON fin_lines(ledger_account_id)",
    "CREATE TABLE IF NOT EXISTS fin_pairs (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        kind TEXT NOT NULL CHECK (kind IN ('transfer','fx')), \
        entry_a INTEGER NOT NULL REFERENCES fin_entries(id) ON DELETE CASCADE, \
        entry_b INTEGER NOT NULL REFERENCES fin_entries(id) ON DELETE CASCADE, \
        adjust_entry_id INTEGER REFERENCES fin_entries(id) ON DELETE SET NULL, \
        status TEXT NOT NULL CHECK (status IN ('auto','review','confirmed','rejected')), \
        score REAL NOT NULL DEFAULT 0, \
        created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_fin_pairs_entity ON fin_pairs(entity_id)",
    "CREATE TABLE IF NOT EXISTS fin_rules (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        position INTEGER NOT NULL DEFAULT 0, \
        conditions_json TEXT NOT NULL DEFAULT '{}', \
        action_json TEXT NOT NULL DEFAULT '{}', \
        learned INTEGER NOT NULL DEFAULT 0, \
        hits INTEGER NOT NULL DEFAULT 0, \
        created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS fin_profiles (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER REFERENCES fin_entities(id) ON DELETE CASCADE, \
        key TEXT NOT NULL, \
        name TEXT NOT NULL, \
        mapping_json TEXT NOT NULL DEFAULT '{}', \
        UNIQUE(entity_id, key))",
    "CREATE TABLE IF NOT EXISTS fin_rates (\
        currency TEXT NOT NULL, \
        date TEXT NOT NULL, \
        rate REAL NOT NULL, \
        source TEXT NOT NULL DEFAULT 'ecb', \
        PRIMARY KEY (currency, date))",
    "CREATE TABLE IF NOT EXISTS fin_periods (\
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        month TEXT NOT NULL, \
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), \
        closed_at TEXT, \
        PRIMARY KEY (entity_id, month))",
    "CREATE TABLE IF NOT EXISTS fin_audit (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        at TEXT NOT NULL, \
        user_id INTEGER NOT NULL, \
        action TEXT NOT NULL, \
        kind TEXT NOT NULL, \
        row_id INTEGER, \
        before_json TEXT, \
        after_json TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON fin_audit(entity_id, at)",
    // Wave 2: recognition schedules, budgets, planned and recurring items, settings.
    "CREATE TABLE IF NOT EXISTS fin_schedules (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        entry_id INTEGER NOT NULL REFERENCES fin_entries(id) ON DELETE CASCADE, \
        ledger_account_id INTEGER NOT NULL REFERENCES fin_ledger_accounts(id), \
        balance_account_id INTEGER NOT NULL REFERENCES fin_ledger_accounts(id), \
        kind TEXT NOT NULL CHECK (kind IN ('prepaid','accrued')), \
        start_month TEXT NOT NULL, \
        months INTEGER NOT NULL, \
        amount_minor INTEGER NOT NULL, \
        deferral_entry_id INTEGER REFERENCES fin_entries(id) ON DELETE SET NULL, \
        created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_fin_schedules_entity ON fin_schedules(entity_id)",
    "CREATE TABLE IF NOT EXISTS fin_schedule_releases (\
        schedule_id INTEGER NOT NULL REFERENCES fin_schedules(id) ON DELETE CASCADE, \
        month TEXT NOT NULL, \
        entry_id INTEGER REFERENCES fin_entries(id) ON DELETE SET NULL, \
        PRIMARY KEY (schedule_id, month))",
    "CREATE TABLE IF NOT EXISTS fin_budgets (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        ledger_account_id INTEGER NOT NULL REFERENCES fin_ledger_accounts(id) ON DELETE CASCADE, \
        month TEXT, \
        amount_minor INTEGER NOT NULL, \
        created_at TEXT NOT NULL, \
        updated_at TEXT NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_budgets_key ON fin_budgets(entity_id, ledger_account_id, IFNULL(month, ''))",
    "CREATE TABLE IF NOT EXISTS fin_planned (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        date TEXT NOT NULL, \
        description TEXT NOT NULL DEFAULT '', \
        amount_minor INTEGER NOT NULL, \
        ledger_account_id INTEGER REFERENCES fin_ledger_accounts(id) ON DELETE SET NULL, \
        account_id INTEGER REFERENCES fin_accounts(id) ON DELETE SET NULL, \
        created_at TEXT NOT NULL, \
        updated_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_fin_planned_entity_date ON fin_planned(entity_id, date)",
    "CREATE TABLE IF NOT EXISTS fin_recurring (\
        id INTEGER PRIMARY KEY AUTOINCREMENT, \
        entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
        key TEXT NOT NULL, \
        label TEXT NOT NULL, \
        cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly','yearly')), \
        amount_minor INTEGER NOT NULL, \
        amount_low_minor INTEGER NOT NULL, \
        amount_high_minor INTEGER NOT NULL, \
        ledger_account_id INTEGER REFERENCES fin_ledger_accounts(id) ON DELETE SET NULL, \
        account_id INTEGER REFERENCES fin_accounts(id) ON DELETE SET NULL, \
        occurrences INTEGER NOT NULL DEFAULT 0, \
        first_date TEXT NOT NULL, \
        last_date TEXT NOT NULL, \
        next_date TEXT NOT NULL, \
        status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','dismissed')), \
        created_at TEXT NOT NULL, \
        updated_at TEXT NOT NULL, \
        UNIQUE(entity_id, key))",
    "CREATE TABLE IF NOT EXISTS fin_settings (\
        entity_id INTEGER PRIMARY KEY REFERENCES fin_entities(id) ON DELETE CASCADE, \
        reminder_enabled INTEGER NOT NULL DEFAULT 1, \
        reminder_weekday TEXT NOT NULL DEFAULT 'Mon', \
        reminder_time TEXT NOT NULL DEFAULT '09:00', \
        reminder_last_at TEXT)",
    // The daily ECB rates fetch runs as a routine (the host's catch-up runner).
    "INSERT INTO routines (name, kind, toolset_json, trigger_json, output_target_json) \
        SELECT 'Exchange rates (ECB)', 'ecb_rates', '[]', '{\"on_launch_after_hours\": 24}', \
               '{\"type\":\"fin_rates\"}' \
        WHERE NOT EXISTS (SELECT 1 FROM routines WHERE kind = 'ecb_rates')",
];

/// Create the finance tables (idempotent). Runs with the other migrations.
pub(crate) async fn migrate(pool: &SqlitePool) -> Result<()> {
    for sql in TABLES {
        sqlx::query(sql).execute(pool).await?;
    }
    // Dedupe by group (`import::dedupe`): the group and the bank's timestamp of each
    // line, backfilled for lines stored before. A batch is `running` until its import
    // finishes, so a rerun of an interrupted import finishes its lines too.
    for (table, column, ty) in [
        ("fin_source_lines", "dedupe_key", "TEXT"),
        ("fin_source_lines", "occurred_at", "TEXT"),
        ("fin_import_batches", "status", "TEXT NOT NULL DEFAULT 'done'"),
        // The inbox's payee group of a draft (`inbox::group_key`), filled when the inbox
        // groups; NULL until then, and again after its text changes.
        ("fin_entries", "group_key", "TEXT"),
        // Import option: post lines older than so many days straight away (off by default).
        // Import option: lines older than so many days file themselves (on, at 90 days, by
        // default; a row written before keeps its choice).
        ("fin_settings", "import_post_older", "INTEGER NOT NULL DEFAULT 1"),
        ("fin_settings", "import_post_older_days", "INTEGER NOT NULL DEFAULT 90"),
        // Payees (`payees`): the entry's and the line's payee, and the alias key it came by
        // (empty once looked at without finding one).
        ("fin_entries", "payee_id", "INTEGER"),
        ("fin_entries", "payee_key", "TEXT"),
        // Posted as unsorted history: an old line no rule, default or suggestion filed.
        ("fin_entries", "unsorted", "INTEGER NOT NULL DEFAULT 0"),
        ("fin_source_lines", "payee_id", "INTEGER"),
        // An account the import made for the other side of a move: no statement of its own has
        // been imported yet, so its balance is only what the other side sent.
        ("fin_accounts", "unconfirmed", "INTEGER NOT NULL DEFAULT 0"),
        // Set once the books' categories and rules have been learned as payee defaults; new
        // entities start with it set.
        ("fin_entities", "payees_learned", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let has: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?")
            .bind(table)
            .bind(column)
            .fetch_one(pool)
            .await?;
        if has == 0 {
            sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}")).execute(pool).await?;
        }
    }
    // The inbox lists, counts and groups drafts by status, newest first, and by payee group.
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_fin_entries_status_date ON fin_entries(entity_id, status, date)",
        "CREATE INDEX IF NOT EXISTS idx_fin_entries_group ON fin_entries(entity_id, status, group_key)",
        "CREATE INDEX IF NOT EXISTS idx_fin_pairs_entry_a ON fin_pairs(entry_a)",
        "CREATE INDEX IF NOT EXISTS idx_fin_pairs_entry_b ON fin_pairs(entry_b)",
        // Deleting an entry looks up the rows that point at it (`reset`): reversals, FX
        // adjustments, schedules and their releases.
        "CREATE INDEX IF NOT EXISTS idx_fin_entries_reverses ON fin_entries(reverses_id) WHERE reverses_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_fin_pairs_adjust ON fin_pairs(adjust_entry_id) WHERE adjust_entry_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_fin_schedules_entry ON fin_schedules(entry_id)",
        "CREATE INDEX IF NOT EXISTS idx_fin_schedules_deferral ON fin_schedules(deferral_entry_id) WHERE deferral_entry_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_fin_schedule_releases_entry ON fin_schedule_releases(entry_id) WHERE entry_id IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS fin_group_suggestions (\
            entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
            group_key TEXT NOT NULL, \
            ledger_account_id INTEGER REFERENCES fin_ledger_accounts(id) ON DELETE CASCADE, \
            created_at TEXT NOT NULL, \
            PRIMARY KEY (entity_id, group_key))",
        "CREATE TABLE IF NOT EXISTS fin_payees (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
            name TEXT NOT NULL, \
            default_ledger_account_id INTEGER REFERENCES fin_ledger_accounts(id) ON DELETE SET NULL, \
            ask_every_time INTEGER NOT NULL DEFAULT 0, \
            merged_into INTEGER REFERENCES fin_payees(id) ON DELETE SET NULL, \
            created_at TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_fin_payees_entity ON fin_payees(entity_id)",
        "CREATE TABLE IF NOT EXISTS fin_payee_aliases (\
            entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
            key TEXT NOT NULL, \
            payee_id INTEGER NOT NULL REFERENCES fin_payees(id) ON DELETE CASCADE, \
            origin_payee_id INTEGER REFERENCES fin_payees(id) ON DELETE SET NULL, \
            sample TEXT NOT NULL DEFAULT '', \
            loose_key TEXT NOT NULL DEFAULT '', \
            PRIMARY KEY (entity_id, key))",
        "CREATE INDEX IF NOT EXISTS idx_fin_payee_aliases_payee ON fin_payee_aliases(payee_id)",
        "CREATE TABLE IF NOT EXISTS fin_payee_dismissed (\
            entity_id INTEGER NOT NULL REFERENCES fin_entities(id) ON DELETE CASCADE, \
            payee_a INTEGER NOT NULL, \
            payee_b INTEGER NOT NULL, \
            created_at TEXT NOT NULL, \
            PRIMARY KEY (entity_id, payee_a, payee_b))",
        "CREATE INDEX IF NOT EXISTS idx_fin_entries_payee ON fin_entries(payee_id) WHERE payee_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_fin_entries_unsorted ON fin_entries(entity_id, payee_id) WHERE unsorted = 1",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    // Payee names: the bank's capitals title-cased once, on the run that adds `renamed`; from
    // then on a payee the user renamed keeps its name.
    let has_renamed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('fin_payees') WHERE name = 'renamed'")
            .fetch_one(pool)
            .await?;
    if has_renamed == 0 {
        sqlx::query("ALTER TABLE fin_payees ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0").execute(pool).await?;
        let names: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM fin_payees").fetch_all(pool).await?;
        for (id, name) in names {
            let titled = super::payees::keys::title_case(&name);
            if titled != name {
                sqlx::query("UPDATE fin_payees SET name = ? WHERE id = ?").bind(titled).bind(id).execute(pool).await?;
            }
        }
    }
    // A payee's default can be a move to one of the user's accounts.
    let has_move: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('fin_payees') WHERE name = 'default_account_id'")
            .fetch_one(pool)
            .await?;
    if has_move == 0 {
        sqlx::query("ALTER TABLE fin_payees ADD COLUMN default_account_id INTEGER").execute(pool).await?;
    }
    // The inbox groups a line by its payee when it has one: keys from the bank's text go.
    sqlx::query(
        "UPDATE fin_entries SET group_key = NULL WHERE status = 'draft' AND payee_id IS NOT NULL \
         AND group_key IS NOT NULL AND group_key NOT LIKE '%:#%'",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_fin_source_lines_dedupe ON fin_source_lines(entity_id, account_id, dedupe_key)",
    )
    .execute(pool)
    .await?;
    super::import::dedupe::backfill(pool).await?;
    // Payees for the lines stored before them come from a background job once the host is up
    // (`payees::backfill`), never here: a big book would hold up the first `/health`.
    // Pairs that waited for review under older pairing rules get another look.
    super::pairing::rescore_at_startup(pool).await;
    Ok(())
}
