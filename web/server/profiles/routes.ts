import type { Request, Response } from "express";
import { query, isDbAvailable } from "../db/pool.js";
import type { AuthUser } from "../auth/jwt.js";

interface ProfileRow {
  id: string;
  name: string;
  created_at: string;
  is_active: boolean;
  best_by_mission: Record<string, unknown>;
  topics_to_review: Record<string, string[]>;
}

function reqUser(req: Request): AuthUser {
  return (req as Request & { user: AuthUser }).user;
}

function mapProfileRow(p: ProfileRow) {
  return {
    id: p.id,
    name: p.name,
    createdAt: new Date(p.created_at).getTime(),
    isActive: p.is_active,
    bestByMission: p.best_by_mission ?? {},
    topicsToReview: p.topics_to_review ?? {},
  };
}

export async function handleGetAccount(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  let result = await query<ProfileRow>(
    `SELECT id, name, created_at, is_active, best_by_mission, topics_to_review
     FROM profiles WHERE user_id = $1
     ORDER BY is_active DESC, created_at ASC LIMIT 1`,
    [user.id],
  );
  if (result.rowCount === 0) {
    const userRow = await query<{ display_name: string; login: string }>(
      `SELECT display_name, login FROM users WHERE id = $1`,
      [user.id],
    );
    const displayName = userRow.rows[0]?.display_name || userRow.rows[0]?.login || "Игрок";
    await query(
      `INSERT INTO profiles (user_id, name, is_active) VALUES ($1, $2, TRUE)`,
      [user.id, displayName],
    );
    result = await query<ProfileRow>(
      `SELECT id, name, created_at, is_active, best_by_mission, topics_to_review
       FROM profiles WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
  }
  const p = result.rows[0];
  if (!p) {
    res.status(404).json({ error: "Профиль не найден" });
    return;
  }
  const runsResult = await query<RunRow>(
    `SELECT id, mission_id, mission_title, completed_at, correct, total,
            total_fine, total_lost_time, history, chat_sessions
     FROM runs WHERE profile_id = $1 ORDER BY completed_at DESC`,
    [p.id],
  );
  res.json({
    profile: {
      ...mapProfileRow(p),
      runs: runsResult.rows.map((r) => ({
        id: r.id,
        missionId: r.mission_id,
        missionTitle: r.mission_title,
        completedAt: Number(r.completed_at),
        correct: r.correct,
        total: r.total,
        totalFine: r.total_fine,
        totalLostTime: r.total_lost_time,
        history: r.history,
        chatSessions: r.chat_sessions,
      })),
    },
  });
}

export async function handleListProfiles(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const result = await query<ProfileRow>(
    `SELECT id, name, created_at, is_active, best_by_mission, topics_to_review
     FROM profiles WHERE user_id = $1 ORDER BY created_at`,
    [user.id],
  );
  res.json({
    profiles: result.rows.map((p: ProfileRow) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).getTime(),
      isActive: p.is_active,
      bestByMission: p.best_by_mission ?? {},
      topicsToReview: p.topics_to_review ?? {},
    })),
  });
}

export async function handleCreateProfile(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const existing = await query(`SELECT id FROM profiles WHERE user_id = $1 LIMIT 1`, [user.id]);
  if ((existing.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "У аккаунта уже есть профиль" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Укажите имя профиля" });
    return;
  }
  const result = await query<ProfileRow>(
    `INSERT INTO profiles (user_id, name) VALUES ($1, $2)
     RETURNING id, name, created_at, is_active, best_by_mission, topics_to_review`,
    [user.id, name],
  );
  const p = result.rows[0];
  res.json({
    profile: {
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).getTime(),
      isActive: p.is_active,
      bestByMission: {},
      topicsToReview: {},
      runs: [],
    },
  });
}

export async function handleDeleteProfile(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const { id } = req.params;
  await query(`DELETE FROM profiles WHERE id = $1 AND user_id = $2`, [id, user.id]);
  res.json({ ok: true });
}

export async function handleSetActiveProfile(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const { id } = req.params;
  await query(`UPDATE profiles SET is_active = FALSE WHERE user_id = $1`, [user.id]);
  await query(
    `UPDATE profiles SET is_active = TRUE WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  res.json({ ok: true });
}

interface RunRow {
  id: string;
  mission_id: string;
  mission_title: string;
  completed_at: string | number;
  correct: number;
  total: number;
  total_fine: number;
  total_lost_time: number;
  history: unknown;
  chat_sessions: unknown;
}

export async function handleGetRuns(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const { id } = req.params;
  const profileCheck = await query(
    `SELECT id FROM profiles WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  if (profileCheck.rowCount === 0) {
    res.status(404).json({ error: "Профиль не найден" });
    return;
  }
  const result = await query<RunRow>(
    `SELECT id, mission_id, mission_title, completed_at, correct, total,
            total_fine, total_lost_time, history, chat_sessions
     FROM runs WHERE profile_id = $1 ORDER BY completed_at DESC`,
    [id],
  );
  res.json({
    runs: result.rows.map((r) => ({
      id: r.id,
      missionId: r.mission_id,
      missionTitle: r.mission_title,
      completedAt: Number(r.completed_at),
      correct: r.correct,
      total: r.total,
      totalFine: r.total_fine,
      totalLostTime: r.total_lost_time,
      history: r.history,
      chatSessions: r.chat_sessions,
    })),
  });
}

export async function handleAddRun(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const { id } = req.params;
  const run = req.body?.run;
  if (!run) {
    res.status(400).json({ error: "run required" });
    return;
  }
  const profileCheck = await query(
    `SELECT id FROM profiles WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  );
  if (profileCheck.rowCount === 0) {
    res.status(404).json({ error: "Профиль не найден" });
    return;
  }
  await query(
    `INSERT INTO runs (id, profile_id, mission_id, mission_title, completed_at,
      correct, total, total_fine, total_lost_time, history, chat_sessions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       history = EXCLUDED.history,
       chat_sessions = EXCLUDED.chat_sessions`,
    [
      run.id,
      id,
      run.missionId,
      run.missionTitle,
      run.completedAt,
      run.correct,
      run.total,
      run.totalFine,
      run.totalLostTime,
      JSON.stringify(run.history ?? []),
      JSON.stringify(run.chatSessions ?? []),
    ],
  );
  if (run.bestByMission || run.topicsToReview) {
    await query(
      `UPDATE profiles SET
         best_by_mission = COALESCE($2, best_by_mission),
         topics_to_review = COALESCE($3, topics_to_review)
       WHERE id = $1`,
      [
        id,
        run.bestByMission ? JSON.stringify(run.bestByMission) : null,
        run.topicsToReview ? JSON.stringify(run.topicsToReview) : null,
      ],
    );
  }
  res.json({ ok: true });
}

export async function handleImportProfiles(req: Request, res: Response): Promise<void> {
  if (!isDbAvailable()) {
    res.status(503).json({ error: "База данных недоступна" });
    return;
  }
  const user = reqUser(req);
  const guestProfile = req.body?.profile as {
    name: string;
    createdAt: number;
    bestByMission: Record<string, unknown>;
    topicsToReview: Record<string, string[]>;
    runs: Array<Record<string, unknown>>;
  } | undefined;

  if (!guestProfile) {
    res.status(400).json({ error: "profile required" });
    return;
  }

  let profileResult = await query<{ id: string; best_by_mission: Record<string, unknown>; topics_to_review: Record<string, string[]> }>(
    `SELECT id, best_by_mission, topics_to_review FROM profiles WHERE user_id = $1 LIMIT 1`,
    [user.id],
  );

  let profileId: string;
  if (profileResult.rowCount === 0) {
    const created = await query<{ id: string }>(
      `INSERT INTO profiles (user_id, name, is_active, best_by_mission, topics_to_review)
       VALUES ($1, $2, TRUE, $3, $4) RETURNING id`,
      [
        user.id,
        guestProfile.name || "Игрок",
        JSON.stringify(guestProfile.bestByMission ?? {}),
        JSON.stringify(guestProfile.topicsToReview ?? {}),
      ],
    );
    profileId = created.rows[0].id;
  } else {
    profileId = profileResult.rows[0].id;
    const existing = profileResult.rows[0];
    const mergedBest = { ...(existing.best_by_mission ?? {}), ...(guestProfile.bestByMission ?? {}) };
    const mergedTopics = { ...(existing.topics_to_review ?? {}), ...(guestProfile.topicsToReview ?? {}) };
    await query(
      `UPDATE profiles SET best_by_mission = $2, topics_to_review = $3 WHERE id = $1`,
      [profileId, JSON.stringify(mergedBest), JSON.stringify(mergedTopics)],
    );
  }

  for (const run of guestProfile.runs ?? []) {
    await query(
      `INSERT INTO runs (id, profile_id, mission_id, mission_title, completed_at,
        correct, total, total_fine, total_lost_time, history, chat_sessions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [
        run.id,
        profileId,
        run.missionId,
        run.missionTitle,
        run.completedAt,
        run.correct,
        run.total,
        run.totalFine,
        run.totalLostTime,
        JSON.stringify(run.history ?? []),
        JSON.stringify(run.chatSessions ?? []),
      ],
    );
  }
  res.json({ profileId });
}
