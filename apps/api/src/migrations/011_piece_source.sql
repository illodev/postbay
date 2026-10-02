-- Where a piece's project lives: the folder of code and material a video is made from (a scene, its assets, voices, a mix
-- script), when it is made that way. The studio does not interpret it: it is an opaque reference that a runner turns into a
-- working directory with its own configuration (apps/runner/README.md, "Pieces made from a project"), such as
-- 'videos:2026-09-29-quarterly-taxes/telenovela'. Null: the piece has no project, and an agent revises its files as they are.
-- One line of printable text: no control characters (no newlines, tabs or escapes), at most 500 characters.
alter table piece add column source text
  constraint piece_source_valid check (
    source is null or (char_length(source) between 1 and 500 and source !~ '[\u0001-\u001f\u007f-\u009f]')
  );
