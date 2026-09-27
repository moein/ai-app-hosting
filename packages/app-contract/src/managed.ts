import { CONTRACT_VERSION } from './version';

/** The only files the platform writes into an app repository (CON-1.1). Protected from write_files (SRC-2.4). */
export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';
export const PLATFORM_JSON_PATH = 'platform.json';
export const MANAGED_PATHS = [PLATFORM_JSON_PATH, DEPLOY_WORKFLOW_PATH] as const;

/** A path the AI may not write: platform.json or anything under .github/ (SRC-2.4). */
export const isManagedPath = (path: string) => path === PLATFORM_JSON_PATH || path.startsWith('.github/');

export const renderPlatformJson = (options: { slug: string; apiOrigin: string }) =>
  `${JSON.stringify({ contract_version: CONTRACT_VERSION, app: options.slug, api: options.apiOrigin }, null, 2)}\n`;

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const SETUP_NODE = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0';

/**
 * Managed build workflow (spec 08, DEP-1): start callback → validate → install → typecheck → build → package →
 * upload, reporting failures back. Authenticated with a fresh GitHub OIDC token per call; holds no secrets.
 */
export const renderDeployWorkflow = (options: {
  apiOrigin: string;
}) => `# Managed by the platform — do not edit (changes are rejected).
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      deployment_id:
        description: Platform deployment id
        required: true
        type: string

concurrency:
  group: deploy
  cancel-in-progress: true

permissions:
  id-token: write
  contents: read

env:
  API: ${options.apiOrigin}

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ${CHECKOUT}

      - uses: ${SETUP_NODE}
        with:
          node-version: 24

      - name: start
        id: start
        env:
          DEPLOYMENT_ID: \${{ inputs.deployment_id }}
        run: |
          set -euo pipefail
          mkdir -p /tmp/logs
          cat > /tmp/platform.sh <<'SH'
          oidc() {
            curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
              "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$API" | jq -r .value
          }
          SH
          . /tmp/platform.sh
          body=$(jq -n --arg sha "$GITHUB_SHA" --argjson run "$GITHUB_RUN_ID" --argjson attempt "$GITHUB_RUN_ATTEMPT" \\
            --arg dep "$DEPLOYMENT_ID" \\
            '{commit_sha: $sha, run_id: $run, run_attempt: $attempt} + (if $dep == "" then {} else {deployment_id: $dep} end)')
          response=$(curl -fsS -X POST "$API/v1/builds/start" -H "Authorization: Bearer $(oidc)" \\
            -H 'content-type: application/json' -d "$body")
          echo "DEP_ID=$(echo "$response" | jq -r .deployment_id)" >> "$GITHUB_ENV"

      - name: validate
        id: validate
        run: |
          set -euo pipefail
          version=$(jq -r .contract_version platform.json)
          curl -fsSL "$API/v1/contract/validator/$version.mjs" -o /tmp/validator.mjs
          node /tmp/validator.mjs . > /tmp/violations.json

      - name: install
        id: install
        run: |
          set -o pipefail
          if [ -f package-lock.json ]; then
            npm ci --no-audit --no-fund 2>&1 | tee /tmp/logs/install.log
          else
            npm install --no-audit --no-fund 2>&1 | tee /tmp/logs/install.log
          fi

      - name: typecheck
        id: typecheck
        run: |
          set -o pipefail
          if jq -e '.scripts.typecheck' package.json > /dev/null; then
            npm run typecheck 2>&1 | tee /tmp/logs/typecheck.log
          fi

      - name: build
        id: build
        run: |
          set -o pipefail
          npm run build 2>&1 | tee /tmp/logs/build.log

      - name: package
        id: package
        run: |
          set -euo pipefail
          mkdir -p migrations
          jq -n --arg c "$GITHUB_SHA" --arg v "$(jq -r .contract_version platform.json)" --arg t "$(date -u +%FT%TZ)" \\
            '{commit_sha: $c, contract_version: $v, built_at: $t}' > manifest.json
          tar czf /tmp/artifact.tgz dist migrations manifest.json 2>&1 | tee /tmp/logs/package.log

      - name: upload
        id: upload
        run: |
          set -euo pipefail
          . /tmp/platform.sh
          curl -fsS -X PUT "$API/v1/builds/$DEP_ID/artifact" -H "Authorization: Bearer $(oidc)" \\
            -H 'content-type: application/gzip' --data-binary @/tmp/artifact.tgz 2>&1 | tee /tmp/logs/upload.log

      - name: report failure
        if: failure() && env.DEP_ID != ''
        env:
          OUTCOMES: >-
            validate=\${{ steps.validate.outcome }} install=\${{ steps.install.outcome }}
            typecheck=\${{ steps.typecheck.outcome }} build=\${{ steps.build.outcome }}
            package=\${{ steps.package.outcome }} upload=\${{ steps.upload.outcome }}
        run: |
          set -uo pipefail
          . /tmp/platform.sh
          step=$(echo "$OUTCOMES" | tr ' ' '\\n' | grep '=failure' | head -n1 | cut -d= -f1)
          step=\${step:-build}
          if [ "$step" = validate ] && [ -s /tmp/violations.json ]; then
            body=$(jq -c '{step: "validate", violations: .violations}' /tmp/violations.json)
          else
            tail=$(tail -n 200 "/tmp/logs/$step.log" 2>/dev/null | tail -c 20000 || true)
            body=$(jq -n --arg step "$step" --arg tail "$tail" '{step: $step, log_tail: $tail}')
          fi
          curl -fsS -X POST "$API/v1/builds/$DEP_ID/fail" -H "Authorization: Bearer $(oidc)" \\
            -H 'content-type: application/json' -d "$body"
`;
