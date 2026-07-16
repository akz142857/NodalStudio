ALTER TABLE refresh_tokens
  ADD COLUMN team_id UUID REFERENCES teams(id);

UPDATE refresh_tokens r
SET team_id = membership.team_id
FROM (
  SELECT user_id, min(team_id::text)::uuid AS team_id
  FROM team_members
  GROUP BY user_id
) membership
WHERE membership.user_id = r.user_id;

ALTER TABLE refresh_tokens
  ALTER COLUMN team_id SET NOT NULL;

ALTER TABLE project_shares
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN last_access_at TIMESTAMPTZ;

UPDATE project_shares
SET expires_at = created_at + interval '7 days'
WHERE expires_at IS NULL;

ALTER TABLE project_shares
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX project_shares_project_created_idx
  ON project_shares(project_id, created_at DESC);
