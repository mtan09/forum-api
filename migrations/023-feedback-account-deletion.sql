-- Account deletion must remove structured feedback text and metadata, not
-- merely detach it from the user. Existing anonymous historical rows are left
-- untouched; the separately enqueued deletion job handles screenshot objects.
ALTER TABLE beta_feedback
  DROP CONSTRAINT IF EXISTS beta_feedback_user_id_fkey;

ALTER TABLE beta_feedback
  ADD CONSTRAINT beta_feedback_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES userdata(id) ON DELETE CASCADE;
