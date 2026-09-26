# Secrets

Use secrets for API keys and anything else that must not be in the code.

- Set: `set_secret({ app, name, value })` — ask the user for the value; never write it into files.
- Names are UPPER_SNAKE_CASE (`STRIPE_API_KEY`), not `DB`, `ASSETS`, `EMAIL`, or a name used in `vars`.
- Read in code as `c.env.STRIPE_API_KEY`; declare it as `string` in your `Env` interface.
- Changes apply immediately, without a redeploy, and survive later deployments.
- `list_secrets` shows names only; `delete_secret` removes one.
- Up to {{MAX_SECRETS_PER_APP}} secrets per app, {{bytes:MAX_SECRET_BYTES}} each.
