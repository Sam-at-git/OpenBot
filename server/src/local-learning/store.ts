/**
 * Local Automatic Learning's own records: the Skills the analyzer proposed, what an administrator decided about each,
 * which conversations have been read, and the analyzer's runs. One SQLite file beside the conversations, so turning
 * local mode on adds no table to the deployment's database and nothing here leaves the machine.
 *
 * ONE PROCESS PER FILE, like the conversation store (local-threads/runner.ts).
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LocalLearnedSkill,
  LocalLearningRun,
  LocalLearningSettings,
  LocalSkillStatus,
} from "@openbot/shared/learning";

export const DEFAULT_LOCAL_LEARNING_SETTINGS: LocalLearningSettings = {
  enabled: true,
  intervalHours: 24,
  excludedAgents: [],
};

type SkillRow = {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  instructions: string;
  rationale: string;
  status: LocalSkillStatus;
  revision_of: string | null;
  source_threads: string;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
};

type RunRow = {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: LocalLearningRun["status"];
  conversations_read: number;
  proposed: number;
  error: string | null;
};

const iso = (value: number) => new Date(value).toISOString();

function skillFrom(row: SkillRow): LocalLearnedSkill {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    rationale: row.rationale,
    status: row.status,
    revisionOf: row.revision_of,
    sourceCount: (JSON.parse(row.source_threads) as string[]).length,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
  };
}

export class LocalSkillConflictError extends Error {
  readonly status = 409;
}

export type ProposedSkill = {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  rationale: string;
  threadId: string;
};

export class LocalLearningStore {
  private readonly db: Database;

  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        revision_of TEXT,
        source_threads TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS skills_agent ON skills(agent_id, status)",
    );
    // At most one approved Skill per Bot and name: that is the name a Bot loads it by.
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS skills_approved_name ON skills(agent_id, name) WHERE status = 'approved'",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS analyzed_threads (
        thread_id TEXT PRIMARY KEY,
        run_count INTEGER NOT NULL,
        analyzed_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        conversations_read INTEGER NOT NULL DEFAULT 0,
        proposed INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // A run cannot outlive the process that ran it.
    this.db.run(
      "UPDATE runs SET status = 'failed', finished_at = ?, error = 'The server stopped during the analysis.' WHERE status = 'running'",
      [this.now()],
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Settings

  settings(): LocalLearningSettings {
    const row = this.db
      .query<{ value: string }, []>(
        "SELECT value FROM settings WHERE key = 'settings'",
      )
      .get();
    if (!row) return { ...DEFAULT_LOCAL_LEARNING_SETTINGS };
    return {
      ...DEFAULT_LOCAL_LEARNING_SETTINGS,
      ...(JSON.parse(row.value) as Partial<LocalLearningSettings>),
    };
  }

  writeSettings(settings: LocalLearningSettings): LocalLearningSettings {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(settings)],
    );
    return this.settings();
  }

  // ---------------------------------------------------------------------------------------------
  // Skills

  skill(id: string): LocalLearnedSkill | undefined {
    const row = this.db
      .query<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?")
      .get(id);
    return row ? skillFrom(row) : undefined;
  }

  /** Pending and approved Skills, then the most recent decided ones. */
  listSkills(): LocalLearnedSkill[] {
    return this.db
      .query<SkillRow, []>(
        `SELECT * FROM (
           SELECT * FROM skills WHERE status IN ('pending', 'approved')
           UNION ALL
           SELECT * FROM (SELECT * FROM skills WHERE status IN ('rejected', 'retired') ORDER BY updated_at DESC LIMIT 30)
         ) ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC`,
      )
      .all()
      .map(skillFrom);
  }

  /** The Skills a Bot's runs use. */
  approvedFor(agentId: string): LocalLearnedSkill[] {
    return this.db
      .query<SkillRow, [string]>(
        "SELECT * FROM skills WHERE agent_id = ? AND status = 'approved' ORDER BY name",
      )
      .all(agentId)
      .map(skillFrom);
  }

  /** What the analyzer is shown so it revises rather than repeats: a Bot's approved and pending Skills. */
  knownFor(agentId: string): LocalLearnedSkill[] {
    return this.db
      .query<SkillRow, [string]>(
        "SELECT * FROM skills WHERE agent_id = ? AND status IN ('approved', 'pending') ORDER BY name",
      )
      .all(agentId)
      .map(skillFrom);
  }

  /** Names an administrator turned down for this Bot, so the analyzer does not propose them again unchanged. */
  rejectedNamesFor(agentId: string): string[] {
    return this.db
      .query<{ name: string }, [string]>(
        "SELECT DISTINCT name FROM skills WHERE agent_id = ? AND status = 'rejected' ORDER BY name",
      )
      .all(agentId)
      .map((row) => row.name);
  }

  /**
   * Record one proposal. A pending Skill of the same name is revised in place (the newest wording wins and the
   * conversation is added to its sources). A name already approved becomes a pending revision of it, left for review.
   */
  propose(input: ProposedSkill): LocalLearnedSkill {
    const now = this.now();
    const id: string = this.db
      .transaction((): string => {
        const pending = this.db
          .query<SkillRow, [string, string]>(
            "SELECT * FROM skills WHERE agent_id = ? AND name = ? AND status = 'pending' LIMIT 1",
          )
          .get(input.agentId, input.name);
        if (pending) {
          const sources = new Set(
            JSON.parse(pending.source_threads) as string[],
          );
          sources.add(input.threadId);
          this.db.run(
            "UPDATE skills SET description = ?, instructions = ?, rationale = ?, source_threads = ?, updated_at = ? WHERE id = ?",
            [
              input.description,
              input.instructions,
              input.rationale,
              JSON.stringify([...sources]),
              now,
              pending.id,
            ],
          );
          return pending.id;
        }
        const approved = this.db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM skills WHERE agent_id = ? AND name = ? AND status = 'approved' LIMIT 1",
          )
          .get(input.agentId, input.name);
        const created = randomUUID();
        this.db.run(
          "INSERT INTO skills (id, agent_id, name, description, instructions, rationale, status, revision_of, source_threads, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
          [
            created,
            input.agentId,
            input.name,
            input.description,
            input.instructions,
            input.rationale,
            approved?.id ?? null,
            JSON.stringify([input.threadId]),
            now,
            now,
          ],
        );
        return created;
      })
      .immediate();
    return this.skill(id) as LocalLearnedSkill;
  }

  /** An administrator's edit. Only pending and approved Skills can change; an approved one changes in place. */
  edit(
    id: string,
    input: { name: string; description: string; instructions: string },
  ): LocalLearnedSkill | undefined {
    const current = this.skill(id);
    if (!current) return undefined;
    if (current.status !== "pending" && current.status !== "approved")
      throw new LocalSkillConflictError(
        "Only a Skill waiting for review or in use can be edited.",
      );
    try {
      this.db.run(
        "UPDATE skills SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?",
        [input.name, input.description, input.instructions, this.now(), id],
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message))
        throw new LocalSkillConflictError(
          "This Bot already uses a Skill with that name. Choose another name.",
        );
      throw error;
    }
    return this.skill(id);
  }

  /**
   * Put a pending Skill into use. The approved Skill it revises, and any other approved Skill of the same name for the
   * same Bot, is retired in the same transaction, so a Bot never holds two Skills by one name.
   */
  approve(id: string, by: string): LocalLearnedSkill | undefined {
    const now = this.now();
    this.db
      .transaction(() => {
        const row = this.db
          .query<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?")
          .get(id);
        if (!row) return;
        if (row.status !== "pending" && row.status !== "retired")
          throw new LocalSkillConflictError(
            "Only a Skill waiting for review or turned off can be put into use.",
          );
        this.db.run(
          "UPDATE skills SET status = 'retired', decided_at = ?, decided_by = ?, updated_at = ? WHERE status = 'approved' AND agent_id = ? AND (name = ? OR id = ?)",
          [now, by, now, row.agent_id, row.name, row.revision_of ?? ""],
        );
        this.db.run(
          "UPDATE skills SET status = 'approved', decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?",
          [now, by, now, id],
        );
      })
      .immediate();
    return this.skill(id);
  }

  /** Turn down a pending Skill, or stop using an approved one. */
  decide(
    id: string,
    status: "rejected" | "retired",
    by: string,
  ): LocalLearnedSkill | undefined {
    const current = this.skill(id);
    if (!current) return undefined;
    const allowed = status === "rejected" ? "pending" : "approved";
    if (current.status !== allowed)
      throw new LocalSkillConflictError(
        status === "rejected"
          ? "Only a Skill waiting for review can be declined."
          : "Only a Skill in use can be turned off.",
      );
    const now = this.now();
    this.db.run(
      "UPDATE skills SET status = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?",
      [status, now, by, now, id],
    );
    return this.skill(id);
  }

  // ---------------------------------------------------------------------------------------------
  // What has been read

  /** Run counts last read per thread. */
  analyzedRunCounts(): Map<string, number> {
    return new Map(
      this.db
        .query<{ thread_id: string; run_count: number }, []>(
          "SELECT thread_id, run_count FROM analyzed_threads",
        )
        .all()
        .map((row) => [row.thread_id, row.run_count]),
    );
  }

  markAnalyzed(threadId: string, runCount: number): void {
    this.db.run(
      "INSERT INTO analyzed_threads (thread_id, run_count, analyzed_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET run_count = excluded.run_count, analyzed_at = excluded.analyzed_at",
      [threadId, runCount, this.now()],
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Runs

  startRun(): number {
    const result = this.db.run(
      "INSERT INTO runs (started_at, status) VALUES (?, 'running')",
      [this.now()],
    );
    return Number(result.lastInsertRowid);
  }

  progressRun(id: number, conversationsRead: number, proposed: number): void {
    this.db.run(
      "UPDATE runs SET conversations_read = ?, proposed = ? WHERE id = ?",
      [conversationsRead, proposed, id],
    );
  }

  finishRun(id: number, error?: string): void {
    this.db.run(
      "UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?",
      [error ? "failed" : "succeeded", this.now(), error ?? null, id],
    );
  }

  latestRun(): LocalLearningRun | null {
    const row = this.db
      .query<RunRow, []>("SELECT * FROM runs ORDER BY id DESC LIMIT 1")
      .get();
    if (!row) return null;
    return {
      startedAt: iso(row.started_at),
      finishedAt: row.finished_at === null ? null : iso(row.finished_at),
      status: row.status,
      conversationsRead: row.conversations_read,
      proposed: row.proposed,
      error: row.error,
    };
  }

  /** When the last run that finished started, in ms, or undefined. A failed run counts: it is retried next interval. */
  lastRunStartedAt(): number | undefined {
    const row = this.db
      .query<{ started_at: number }, []>(
        "SELECT started_at FROM runs ORDER BY id DESC LIMIT 1",
      )
      .get();
    return row?.started_at;
  }

  close(): void {
    this.db.close();
  }
}
