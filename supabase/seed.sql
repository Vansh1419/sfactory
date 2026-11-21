-- Development seed (PLAN.md step 1.1): one fake client, project, pod and agent.
-- Safe to run more than once. It is NOT part of the migrations, so it never reaches
-- a project unless you run it on purpose. Every row is labelled "[seed]" so it is easy to find and delete.

insert into public.clients (id, name, status)
values ('5eed0000-0000-4000-8000-000000000001', '[seed] Demo Client', 'lead')
on conflict (id) do nothing;

insert into public.projects (id, client_id, name, kind, service, status)
values ('5eed0000-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-000000000001',
        '[seed] Demo website', 'agency_client', 'web_development', 'planned')
on conflict (id) do nothing;

insert into public.pods (id, project_id, template)
values ('5eed0000-0000-4000-8000-000000000003', '5eed0000-0000-4000-8000-000000000002', 'agency_client')
on conflict (id) do nothing;

insert into public.agents (id, name, team, role)
values ('5eed0000-0000-4000-8000-000000000004', '[seed] Demo worker', 'product_engineering', 'worker')
on conflict (id) do nothing;

insert into public.pod_members (pod_id, agent_id)
values ('5eed0000-0000-4000-8000-000000000003', '5eed0000-0000-4000-8000-000000000004')
on conflict (pod_id, agent_id) do nothing;
