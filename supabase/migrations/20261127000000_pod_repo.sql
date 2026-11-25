-- A project's own GitHub repository (PLAN.md step 3.3). The Engineering team opens pull requests in the repository of the pod it works in, and in no
-- other: the pod's tools take the repository from this column, never from what a model says. The founder's own list (GITHUB_REPOS) still decides which
-- repositories can be named at all; this column ties one project to one of them, and is set when the pod is opened on the founder's approved card.
--   - the name must look like owner/name, with no folder-like parts ("..")
--   - once a project has a repository it can never be pointed at another one (or at none): a pod's tools must not be able to be redirected
--     by anything that can write a project row. It can be set once, from empty.

alter table public.projects add column github_repo text
  constraint projects_github_repo_shape check (
    github_repo is null
    or (github_repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' and github_repo !~ '(^|/)\.+(/|$)')
  );

create function private.projects_guard_repo() returns trigger
language plpgsql as $$
begin
  if old.github_repo is not null and new.github_repo is distinct from old.github_repo then
    raise exception 'project % already has its repository and it cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger projects_guard_repo
  before update on public.projects
  for each row execute function private.projects_guard_repo();
