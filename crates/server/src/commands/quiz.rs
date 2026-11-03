//! Quizzes (the QuizForge adoption): a project's subjects, their topics and questions, the
//! quizzes and exams drawn from them, and the attempts members record.

use ganban_core::auth;
use ganban_core::quiz;
use serde_json::{json, Value};

use super::{command, missing, reply, require_role, Access, Args, Author, Command, Target, PROJECT};

/// The subject named by `subjectId`.
const SUBJECT: Target = Target::arg("subjectId", |db, id| Box::pin(async move { Ok(Some(quiz::subject_project(db, id).await?)) }));

/// The topic named by `topicId`.
const TOPIC: Target = Target::arg("topicId", |db, id| Box::pin(async move { Ok(Some(quiz::topic_project(db, id).await?)) }));

/// The topic a merge pours into, by `intoTopicId` (ops refuses a source in another project).
const INTO_TOPIC: Target =
    Target::arg("intoTopicId", |db, id| Box::pin(async move { Ok(Some(quiz::topic_project(db, id).await?)) }));

/// The anchor topic of an approved question batch, by `topic_id` (the agent tools' shape).
const BATCH_TOPIC: Target =
    Target::arg("topic_id", |db, id| Box::pin(async move { Ok(Some(quiz::topic_project(db, id).await?)) }));

/// The anchor subject of an approved question batch with no anchor topic, by `subject_id`
/// (✨ Automatic's shape).
const BATCH_SUBJECT: Target =
    Target::arg("subject_id", |db, id| Box::pin(async move { Ok(Some(quiz::subject_project(db, id).await?)) }));

/// The question named by `questionId`.
const QUESTION: Target =
    Target::arg("questionId", |db, id| Box::pin(async move { Ok(Some(quiz::question_project(db, id).await?)) }));

/// The quiz named by `quizId`.
const QUIZ: Target = Target::arg("quizId", |db, id| Box::pin(async move { Ok(Some(quiz::quiz_project(db, id).await?)) }));

/// What a new quiz draws from: topics (`topicIds`, or the legacy single `topicId`), or else
/// its whole subject (`subjectId`).
fn quiz_scope(a: &Args<'_>) -> (Option<Vec<i64>>, Option<i64>) {
    let topics = Some(a.i64_list("topicIds")).filter(|ids| !ids.is_empty()).or_else(|| a.opt_i64("topicId").map(|t| vec![t]));
    (topics, a.opt_i64("subjectId"))
}

pub(super) const COMMANDS: &[Command] = &[
    // ----- Subjects -----
    command("get_quiz_subjects")
        .access(Access::Member(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_subjects(cx.db, a.id(PROJECT)?).await?) })),
    command("create_quiz_subject").access(Access::Member(PROJECT)).run(|cx, a| {
        Box::pin(async move {
            reply(
                quiz::create_subject(cx.db, a.id(PROJECT)?, &a.req_str("name")?, a.opt_str("color").as_deref(), a.opt_str("icon").as_deref())
                    .await?,
            )
        })
    }),
    command("update_quiz_subject").access(Access::Member(SUBJECT)).run(|cx, a| {
        Box::pin(async move {
            reply(
                quiz::update_subject(
                    cx.db,
                    a.id(SUBJECT)?,
                    a.opt_str("name").as_deref(),
                    a.opt_str("color").as_deref(),
                    a.opt_str("icon").as_deref(),
                )
                .await?,
            )
        })
    }),
    command("delete_quiz_subject")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::delete_subject(cx.db, a.id(SUBJECT)?).await?) })),
    command("get_quiz_exams")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_exams(cx.db, a.id(SUBJECT)?).await?) })),
    command("get_subject_quizzes")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_subject_quizzes(cx.db, a.id(SUBJECT)?).await?) })),
    command("get_subject_quiz_questions")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_subject_questions(cx.db, a.id(SUBJECT)?).await?) })),
    command("get_quiz_leaderboard")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::leaderboard(cx.db, a.id(SUBJECT)?).await?) })),
    // A member's own leaderboard opt-in: over HTTP always the caller's.
    command("get_quiz_leaderboard_optin").access(Access::Member(PROJECT)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move { reply(quiz::get_leaderboard_optin(cx.db, a.id(PROJECT)?, a.author()?).await?) })
    }),
    command("set_quiz_leaderboard_optin").access(Access::Member(PROJECT)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move {
            let opt_in = a.opt_bool("optIn").unwrap_or(false);
            reply(quiz::set_leaderboard_optin(cx.db, a.id(PROJECT)?, a.author()?, opt_in).await?)
        })
    }),
    // ----- Topics -----
    command("get_quiz_topics")
        .access(Access::Member(SUBJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_topics(cx.db, a.id(SUBJECT)?).await?) })),
    command("get_all_quiz_topics")
        .access(Access::Member(PROJECT))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_all_topics(cx.db, a.id(PROJECT)?).await?) })),
    command("create_quiz_topic").access(Access::Member(SUBJECT)).run(|cx, a| {
        Box::pin(async move {
            reply(quiz::create_topic(cx.db, a.id(SUBJECT)?, &a.req_str("name")?, a.opt_str("description").as_deref()).await?)
        })
    }),
    command("update_quiz_topic").access(Access::Member(TOPIC)).run(|cx, a| {
        Box::pin(async move {
            reply(quiz::update_topic(cx.db, a.id(TOPIC)?, a.opt_str("name").as_deref(), a.opt_str("description").as_deref()).await?)
        })
    }),
    command("delete_quiz_topic")
        .access(Access::Member(TOPIC))
        .run(|cx, a| Box::pin(async move { reply(quiz::delete_topic(cx.db, a.id(TOPIC)?).await?) })),
    command("merge_quiz_topics").access(Access::Member(INTO_TOPIC)).run(|cx, a| {
        Box::pin(async move { reply(quiz::merge_topics(cx.db, a.req_i64("fromTopicId")?, a.id(INTO_TOPIC)?).await?) })
    }),
    // ----- Questions -----
    command("get_quiz_questions")
        .access(Access::Member(TOPIC))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_questions(cx.db, a.id(TOPIC)?).await?) })),
    command("create_quiz_question").access(Access::Member(TOPIC)).run(|cx, a| {
        Box::pin(async move {
            reply(
                quiz::create_question(
                    cx.db,
                    a.id(TOPIC)?,
                    &a.req_str("questionType")?,
                    &a.req_str("questionText")?,
                    a.opt_str("explanation").as_deref(),
                    &a.opt_str("difficulty").unwrap_or_else(|| "MEDIUM".into()),
                    a.opt_i64("points").unwrap_or(1),
                    a.opt_str("source").as_deref(),
                    &a.req_str("dataJson")?,
                )
                .await?,
            )
        })
    }),
    command("update_quiz_question").access(Access::Member(QUESTION)).run(|cx, a| {
        Box::pin(async move {
            reply(
                quiz::update_question(
                    cx.db,
                    a.id(QUESTION)?,
                    a.opt_str("questionText").as_deref(),
                    a.opt_str("explanation").as_deref(),
                    a.opt_str("difficulty").as_deref(),
                    a.opt_i64("points"),
                    a.opt_str("source").as_deref(),
                    a.opt_str("dataJson").as_deref(),
                )
                .await?,
            )
        })
    }),
    command("delete_quiz_question")
        .access(Access::Member(QUESTION))
        .run(|cx, a| Box::pin(async move { reply(quiz::delete_question(cx.db, a.id(QUESTION)?).await?) })),
    // ops refuses a question from another project.
    command("move_quiz_questions").access(Access::Member(TOPIC)).run(|cx, a| {
        Box::pin(async move { reply(quiz::move_questions(cx.db, &a.i64_list("ids"), a.id(TOPIC)?).await?) })
    }),
    // The gate's apply path for quiz.generate proposals. The anchor topic names the
    // subject; a per-question "topic" files the question under a sibling topic, created on
    // demand, so one batch can populate a whole lecture series. Anchored on a subject
    // instead (✨ Automatic), strays land in a "General" topic created on demand.
    // Anchored on a topic, or else on a subject (✨ Automatic): scoped by that one's project.
    command("create_quiz_questions_batch")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                let anchor = if a.opt_id(BATCH_TOPIC).is_some() { BATCH_TOPIC } else { BATCH_SUBJECT };
                Access::Member(anchor).check(cx, user, a).await
            })
        }))
        .run(|cx, a| {
            Box::pin(async move {
                let topic_id = a.opt_id(BATCH_TOPIC);
                let subject_id: i64 = match topic_id {
                    Some(t) => sqlx::query_scalar("SELECT subject_id FROM quiz_topics WHERE id = ?").bind(t).fetch_one(cx.db).await?,
                    None => a.id(BATCH_SUBJECT)?,
                };
                let empty = vec![];
                let questions = a.get("questions").and_then(Value::as_array).unwrap_or(&empty);
                // Apply-time dedup: two overlapping proposals approved in sequence must not
                // double-insert; the second's duplicates are skipped.
                let mut seen = quiz::subject_fingerprints(cx.db, subject_id).await?;
                let (mut created, mut skipped) = (0i64, 0i64);
                for q in questions {
                    let text = q["questionText"].as_str().unwrap_or("");
                    let fp = quiz::question_fingerprint(text);
                    if seen.contains(&fp) {
                        skipped += 1;
                        continue;
                    }
                    let target_topic = match q["topic"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                        Some(name) => quiz::find_or_create_topic(cx.db, subject_id, name).await?,
                        None => match topic_id {
                            Some(t) => t,
                            None => quiz::find_or_create_topic(cx.db, subject_id, "General").await?,
                        },
                    };
                    quiz::create_question(
                        cx.db,
                        target_topic,
                        q["questionType"].as_str().unwrap_or(""),
                        text,
                        q["explanation"].as_str().filter(|s| !s.trim().is_empty()),
                        q["difficulty"].as_str().unwrap_or("MEDIUM"),
                        q["points"].as_i64().unwrap_or(1),
                        Some(q["source"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("AI-drafted (approved)")),
                        &q["data"].to_string(),
                    )
                    .await?;
                    seen.insert(fp);
                    created += 1;
                }
                Ok(json!({ "created": created, "skipped_duplicates": skipped }))
            })
        }),
    // ----- Quizzes and attempts -----
    command("get_quizzes")
        .access(Access::Member(TOPIC))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_quizzes(cx.db, a.id(TOPIC)?).await?) })),
    // A quiz is scoped by its first topic, or by its subject when it spans the subject.
    command("create_quiz")
        .access(Access::Custom(|cx, a, user| {
            Box::pin(async move {
                let project = match quiz_scope(a) {
                    (Some(topics), _) => quiz::topic_project(cx.db, topics[0]).await?,
                    (None, Some(subject)) => quiz::subject_project(cx.db, subject).await?,
                    (None, None) => return Err(missing("subjectId")),
                };
                require_role(cx.db, user, project, auth::ROLE_MEMBER).await
            })
        }))
        .run(|cx, a| {
            Box::pin(async move {
                let (topics, subject) = quiz_scope(a);
                reply(
                    quiz::create_quiz(
                        cx.db,
                        &a.opt_str("kind").unwrap_or_else(|| "quiz".into()),
                        topics.as_deref(),
                        subject,
                        &a.req_str("name")?,
                        a.opt_str("description").as_deref(),
                        a.opt_i64("questionCount").unwrap_or(10),
                        a.opt_i64("timeLimitMinutes"),
                        a.opt_bool("shuffleQuestions").unwrap_or(true),
                        a.opt_bool("shuffleOptions").unwrap_or(true),
                        &a.opt_str("showAnswersAfter").unwrap_or_else(|| "END_OF_QUIZ".into()),
                        a.opt_i64("passingScorePercent").unwrap_or(60),
                    )
                    .await?,
                )
            })
        }),
    command("delete_quiz")
        .access(Access::Member(QUIZ))
        .run(|cx, a| Box::pin(async move { reply(quiz::delete_quiz(cx.db, a.id(QUIZ)?).await?) })),
    command("get_quiz_attempts")
        .access(Access::Member(QUIZ))
        .run(|cx, a| Box::pin(async move { reply(quiz::get_attempts(cx.db, a.id(QUIZ)?).await?) })),
    // An attempt is the caller's own over HTTP.
    command("record_quiz_attempt").access(Access::Member(QUIZ)).author(Author::Arg("userId")).run(|cx, a| {
        Box::pin(async move {
            reply(
                quiz::record_attempt(
                    cx.db,
                    a.id(QUIZ)?,
                    a.opt_author(),
                    a.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                    a.get("maxScore").and_then(Value::as_f64).unwrap_or(0.0),
                    a.opt_i64("timeTakenSeconds"),
                    &a.req_str("answersJson")?,
                )
                .await?,
            )
        })
    }),
];

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::testkit::*;

    /// A subject, topic, question and quiz in project A, and the same chain in B.
    struct Chain {
        project: i64,
        subject: i64,
        topic: i64,
        question: i64,
        quiz: i64,
    }

    async fn chain(db: &ganban_core::Db, name: &str) -> Chain {
        let project = seed(db, "create_project", json!({ "input": { "name": name } })).await["id"].as_i64().unwrap();
        let subject = seed(db, "create_quiz_subject", json!({ "projectId": project, "name": "S" })).await["id"].as_i64().unwrap();
        let topic = seed(db, "create_quiz_topic", json!({ "subjectId": subject, "name": "T" })).await["id"].as_i64().unwrap();
        let question = seed(
            db,
            "create_quiz_question",
            json!({ "topicId": topic, "questionType": "NUMERIC_INPUT", "questionText": "6 × 7?", "dataJson": "{\"correctAnswer\":42}" }),
        )
        .await["id"]
            .as_i64()
            .unwrap();
        let quiz = seed(db, "create_quiz", json!({ "topicIds": [topic], "name": "Q" })).await["id"].as_i64().unwrap();
        Chain { project, subject, topic, question, quiz }
    }

    #[tokio::test]
    async fn every_quiz_scope_needs_membership_of_its_project() {
        let db = test_db("quiz_rules").await;
        owner(&db).await;
        let a = chain(&db, "A").await;
        let b = chain(&db, "B").await;
        let mia = member(&db, 7, &[(a.project, "member")]).await;

        let reads = |c: &Chain| -> Vec<(&'static str, Value)> {
            vec![
                ("get_quiz_subjects", json!({ "projectId": c.project })),
                ("get_quiz_topics", json!({ "subjectId": c.subject })),
                ("get_quiz_questions", json!({ "topicId": c.topic })),
                ("update_quiz_question", json!({ "questionId": c.question, "points": 2 })),
                ("get_quiz_attempts", json!({ "quizId": c.quiz })),
                ("create_quiz", json!({ "topicIds": [c.topic], "name": "Mine" })),
                ("create_quiz", json!({ "subjectId": c.subject, "name": "Whole subject", "kind": "exam" })),
            ]
        };
        for (cmd, args) in reads(&a) {
            assert!(http(&db, mia, cmd, args).await.is_ok(), "{cmd} in her project");
        }
        for (cmd, args) in reads(&b) {
            let err = http(&db, mia, cmd, args).await.unwrap_err();
            assert!(err.is_not_found(), "{cmd} in another project looks absent: {err}");
        }
        let attempt = |quiz: i64| json!({ "quizId": quiz, "score": 1.0, "maxScore": 1.0, "answersJson": "{}" });
        assert!(http(&db, mia, "record_quiz_attempt", attempt(a.quiz)).await.is_ok());
        assert!(http(&db, mia, "record_quiz_attempt", attempt(b.quiz)).await.unwrap_err().is_not_found());
    }

    #[tokio::test]
    async fn attempts_and_leaderboard_optins_are_the_callers_own() {
        let db = test_db("quiz_author").await;
        owner(&db).await;
        let a = chain(&db, "A").await;
        let mia = member(&db, 7, &[(a.project, "member")]).await;
        member(&db, 8, &[(a.project, "member")]).await;

        let spoofed = json!({ "quizId": a.quiz, "userId": 8, "score": 1.0, "maxScore": 1.0, "answersJson": "{}" });
        http(&db, mia, "record_quiz_attempt", spoofed).await.unwrap();
        let attempts = seed(&db, "get_quiz_attempts", json!({ "quizId": a.quiz })).await;
        assert_eq!(attempts[0]["user_id"], 7, "the attempt is hers, not user 8's");

        http(&db, mia, "set_quiz_leaderboard_optin", json!({ "projectId": a.project, "userId": 8, "optIn": true })).await.unwrap();
        let optin = |user: i64| seed(&db, "get_quiz_leaderboard_optin", json!({ "projectId": a.project, "userId": user }));
        assert_eq!(optin(7).await, true, "she opted herself in");
        assert_eq!(optin(8).await, false, "user 8 was left alone");
        let read = json!({ "projectId": a.project, "userId": 8 });
        assert_eq!(http(&db, mia, "get_quiz_leaderboard_optin", read).await.unwrap(), true, "she reads her own opt-in");

        // In-process (the desktop) the app's profile id stands.
        seed(&db, "set_quiz_leaderboard_optin", json!({ "projectId": a.project, "userId": 8, "optIn": true })).await;
        assert_eq!(optin(8).await, true);
        seed(&db, "record_quiz_attempt", json!({ "quizId": a.quiz, "userId": 8, "score": 1.0, "maxScore": 1.0, "answersJson": "{}" })).await;
        assert_eq!(seed(&db, "get_quiz_attempts", json!({ "quizId": a.quiz })).await[0]["user_id"], 8);
    }

    #[tokio::test]
    async fn an_approved_batch_needs_membership_of_its_anchor() {
        let db = test_db("quiz_batch").await;
        owner(&db).await;
        let a = chain(&db, "A").await;
        let b = chain(&db, "B").await;
        let mia = member(&db, 7, &[(a.project, "member")]).await;
        let batch = |topic: i64| {
            json!({ "topic_id": topic, "questions": [
                { "questionType": "NUMERIC_INPUT", "questionText": "2 + 2?", "data": { "correctAnswer": 4 } },
                { "questionType": "NUMERIC_INPUT", "questionText": "6 × 7?", "data": { "correctAnswer": 42 } },
            ] })
        };
        let r = http(&db, mia, "create_quiz_questions_batch", batch(a.topic)).await.unwrap();
        assert_eq!((r["created"].as_i64(), r["skipped_duplicates"].as_i64()), (Some(1), Some(1)), "the duplicate is skipped");
        assert!(http(&db, mia, "create_quiz_questions_batch", batch(b.topic)).await.unwrap_err().is_not_found());

        // ✨ Automatic anchors a batch on the subject instead.
        let by_subject = |subject: i64| {
            json!({ "subject_id": subject, "questions": [
                { "questionType": "NUMERIC_INPUT", "questionText": "3 + 3?", "data": { "correctAnswer": 6 } },
            ] })
        };
        let r = http(&db, mia, "create_quiz_questions_batch", by_subject(a.subject)).await.unwrap();
        assert_eq!(r["created"].as_i64(), Some(1));
        assert!(http(&db, mia, "create_quiz_questions_batch", by_subject(b.subject)).await.unwrap_err().is_not_found());
    }
}
