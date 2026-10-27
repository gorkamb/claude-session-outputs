---
description: Write this project's session-outputs config (production names and destructive commands)
---

Set up the session-outputs plugin for this project: write `.claude/session-outputs.json` at the project root (create `.claude/` if needed; if the file exists, keep its entries and add to them).

The file holds two arrays of strings, "prod" and "destroy". Each entry is a plain substring (any case) or a regular expression written /pattern/flags.
- "prod": words that mean a command or query targets production: deploy tools, environment names, production hosts, database or cluster names.
- "destroy": project-specific commands that delete, wipe or overwrite data (custom scripts, artisan/rake/manage.py tasks, Make targets). They show in red.

Look at whichever of these the project has:
- Deploy and hosting: vapor.yml, fly.toml, serverless.yml, render.yaml, railway.json or railway.toml, vercel.json, netlify.toml, app.yaml (App Engine), Procfile and app.json (Heroku), amplify.yml, wrangler.toml (Cloudflare), firebase.json, supabase/config.toml, config/deploy.yml (Kamal), config/deploy*.rb (Capistrano), Envoy.blade.php, Dockerfile and docker-compose files.
- Infrastructure: Terraform or OpenTofu (*.tf), Pulumi, AWS CDK (cdk.json), SAM or CloudFormation templates, Kubernetes manifests, Helm charts, Ansible playbooks.
- CI and release: .github/workflows, .gitlab-ci.yml, .circleci, bitbucket-pipelines.yml.
- Scripts and tasks: package.json, composer.json, pyproject.toml, Makefile, Justfile, Taskfile.yml, Rakefile, Laravel app/Console/Commands, Django management commands, Rails lib/tasks, mix tasks, bin/, scripts/.
- Docs and environment names: CLAUDE.md, AGENTS.md, README, docs/, .env.example. Never open a real .env, and never copy a secret, token, password or connection string into the file: names only.

Leave out entries that are personal or shared across projects: those belong in ~/.claude/session-outputs.json. Then show me the file, with one line per entry on why it is there.
