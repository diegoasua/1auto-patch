# Credential Autopatch

Hackathon demo: detect risky passwords, require explicit approval, then run a browser agent in an isolated execution context to change the password and update the vault record only after success.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000.

## Demo Flow

1. Click `Scan`.
2. Choose the `AGI House Demo` credential.
3. Click `Repair`.
4. Watch the agent log in to the local demo website, change the password, and update the vault.

## Sponsor Hooks

- 1Password: set `VAULT_PROVIDER=1password` and authenticate the official `op` CLI. Optional env: `OP_VAULT`, `OP_ITEM_LIMIT`, `OP_PASSWORD_FIELD`.
- Daytona: set `DAYTONA_API_KEY` and `REPAIR_RUNTIME=daytona`. For this local demo target, expose the app publicly and set `DAYTONA_PUBLIC_BASE_URL` because a remote sandbox cannot call your laptop's `localhost`.

## Safety Model

- No autonomous repair without click approval.
- The agent receives only the selected credential.
- New password is generated locally.
- Vault update happens after the website confirms password change.
- Breach checking can be enabled with `HIBP_LIVE_CHECK=true`; it uses SHA-1 k-anonymity range lookup and never sends the full password hash.

## Environment

```bash
# 1Password real vault mode
VAULT_PROVIDER=1password
OP_VAULT="Hackathon Demo"
OP_ITEM_LIMIT=25

# Daytona sandbox repair mode
DAYTONA_API_KEY=...
DAYTONA_TARGET=us
REPAIR_RUNTIME=daytona
DAYTONA_PUBLIC_BASE_URL=https://your-tunnel.example.com
```

## Real Integration Checklist

1. Sign in to 1Password CLI:

```bash
op signin
op whoami
```

2. For a tightly scoped demo, create a vault named `Hackathon Demo`, copy 1-3 login items into it, and set:

```bash
VAULT_PROVIDER=1password
OP_VAULT=Hackathon Demo
```

3. Add Daytona credentials:

```bash
DAYTONA_API_KEY=...
DAYTONA_TARGET=us
```

4. To make the bundled demo target reachable from Daytona, expose this app:

```bash
cloudflared tunnel --url http://localhost:3000
```

Set `DAYTONA_PUBLIC_BASE_URL` to the HTTPS tunnel URL, then:

```bash
REPAIR_RUNTIME=daytona
```

## Real-Site Notes

For real sites, the scanner uses an adapter registry:

- Controlled local demo target: repairable.
- `app.agihouse.org`: classified as passwordless because the public sign-in flow exposes magic link and Google sign-in, but no password field.
- Other sites: generic browser repair is disabled by default. Enable it with `ENABLE_GENERIC_REPAIR=true` only for throwaway accounts.

For better real-site results, add a custom 1Password field named `change password url` or add a second URL whose label or value includes `password`, `change`, or `security`.

The Daytona browser path starts computer-use services, launches Chromium inside the sandbox, performs the repair, verifies where possible, then updates 1Password. A local ignored `repair-recovery.local.json` ledger is written before site mutation so the generated password is not lost if the vault update fails.
