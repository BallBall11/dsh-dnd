# AGENTS.md

## Verification

Full gate: `npm run check`; CI reruns the portable subset on every push. See `.github/workflows/ci.yml`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at BallBall11/dsh-dnd, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles; label strings equal the role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`, created lazily as decisions land. See `docs/agents/domain.md`.
