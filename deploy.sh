#!/usr/bin/env bash
# Despliegue del updater. Todo sale de config.toml: este script no tiene valores propios.
#
#   ./deploy.sh              compila, sube el .zip y actualiza el stack
#   ./deploy.sh token        guarda github.token en SSM como SecureString y sale
#   ./deploy.sh dry-run      corre el updater en local sin commitear
#   ./deploy.sh backfill     regenera docs/ desde data/ con el codificador actual
#   ./deploy.sh invoke       invoca la lambda desplegada y muestra su salida
#   ./deploy.sh logs         sigue los logs de la lambda
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=config.toml
[ -f "$CONFIG" ] || { echo "Falta $CONFIG — copia config.example.toml y complétalo." >&2; exit 1; }

# config.toml se lee con tomllib en vez de con grep/sed: el formato tiene comentarios y
# comillas, y un parseo a mano fallaría en silencio justo cuando cambie un valor.
eval "$(python3 - "$CONFIG" <<'PY'
import sys, tomllib, shlex
with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)

def emit(name, value):
    print(f"{name}={shlex.quote(str(value))}")

github, aws, updater = config.get("github", {}), config.get("aws", {}), config.get("updater", {})
emit("GITHUB_OWNER", github.get("owner", ""))
emit("GITHUB_REPO", github.get("repo", ""))
emit("GITHUB_BRANCH", github.get("branch", "main"))
emit("GITHUB_COMMIT_NAME", github.get("commit_name", ""))
emit("GITHUB_COMMIT_EMAIL", github.get("commit_email", ""))
emit("GITHUB_TOKEN", github.get("token", ""))
emit("AWS_REGION_CFG", aws.get("region", "us-east-1"))
emit("AWS_PROFILE_CFG", aws.get("profile", "default"))
emit("DEPLOYMENT_BUCKET", aws.get("deployment_bucket", ""))
emit("GITHUB_TOKEN_SSM", aws.get("github_token_ssm", ""))
emit("SCHEDULE", aws.get("schedule", ""))
emit("LOOKBACK_DAYS", updater.get("lookback_days", 0))
PY
)"

# El prefijo de los recursos es el nombre del repo: no hay un app_name aparte que pueda
# divergir de él.
NAME_PREFIX="$GITHUB_REPO"
STACK_NAME="$NAME_PREFIX-updater"
S3_KEY="$NAME_PREFIX/updater.zip"
AWSX=(aws --profile "$AWS_PROFILE_CFG" --region "$AWS_REGION_CFG")

GO_BIN=go
[ -x /usr/local/go/bin/go ] && GO_BIN=/usr/local/go/bin/go

case "${1:-deploy}" in

  backfill)
    cd updater
    exec "$GO_BIN" run ./cmd/backfill -source ../data/tipo-cambio-sunat-usd-pen.json -out ../docs
    ;;

  dry-run)
    cd updater
    # Sale con 2 cuando hay algo que publicar, para que un CI pueda distinguirlo de "al día".
    exec "$GO_BIN" run ./cmd/updater -config ../config.toml -dry-run
    ;;

  token)
    [ -n "$GITHUB_TOKEN" ] || { echo "github.token está vacío en $CONFIG." >&2; exit 1; }
    [ -n "$GITHUB_TOKEN_SSM" ] || { echo "aws.github_token_ssm está vacío en $CONFIG." >&2; exit 1; }
    "${AWSX[@]}" ssm put-parameter \
      --name "$GITHUB_TOKEN_SSM" --type SecureString --value "$GITHUB_TOKEN" --overwrite \
      --description "PAT fine-grained (Contents: write) de $GITHUB_OWNER/$GITHUB_REPO" >/dev/null
    echo "Token guardado en $GITHUB_TOKEN_SSM."
    exit 0
    ;;

  invoke)
    OUT=$(mktemp)
    "${AWSX[@]}" lambda invoke --function-name "$NAME_PREFIX-updater" \
      --cli-binary-format raw-in-base64-out --payload '{}' "$OUT" >/dev/null
    cat "$OUT"; echo; rm -f "$OUT"
    exit 0
    ;;

  logs)
    exec "${AWSX[@]}" logs tail "/aws/lambda/$NAME_PREFIX-updater" --follow --since 1h
    ;;

  deploy) ;;
  *) echo "Acción desconocida: $1" >&2; exit 1 ;;
esac

# ─── deploy ─────────────────────────────────────────────────────────────────
echo "==> Cuenta"
"${AWSX[@]}" sts get-caller-identity --query '[Account,Arn]' --output text

echo "==> Tests"
( cd updater && "$GO_BIN" test ./... )

echo "==> Compilando arm64"
# CGO apagado y binario estático: provided.al2023 sólo ejecuta 'bootstrap' y no trae libc
# que valga para un binario enlazado dinámicamente. -s -w le quita ~30% de tamaño.
( cd updater && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    "$GO_BIN" build -trimpath -ldflags="-s -w" -o bootstrap ./cmd/updater )

( cd updater && rm -f updater.zip && zip -q -X updater.zip bootstrap )
echo "    $(du -h updater/updater.zip | cut -f1)"

echo "==> Subiendo a s3://$DEPLOYMENT_BUCKET/$S3_KEY"
"${AWSX[@]}" s3 cp updater/updater.zip "s3://$DEPLOYMENT_BUCKET/$S3_KEY" --only-show-errors

echo "==> Desplegando $STACK_NAME"
# CAPABILITY_NAMED_IAM porque el stack crea su propio rol con nombre fijo (ver template.yml).
"${AWSX[@]}" cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file updater/cloud/template.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    NamePrefix="$NAME_PREFIX" \
    DeploymentBucket="$DEPLOYMENT_BUCKET" \
    CompiledS3Key="$S3_KEY" \
    GitHubOwner="$GITHUB_OWNER" \
    GitHubRepo="$GITHUB_REPO" \
    GitHubBranch="$GITHUB_BRANCH" \
    GitHubCommitName="$GITHUB_COMMIT_NAME" \
    GitHubCommitEmail="$GITHUB_COMMIT_EMAIL" \
    GitHubTokenSSM="$GITHUB_TOKEN_SSM" \
    LookbackDays="$LOOKBACK_DAYS" \
    Schedule="$SCHEDULE"

# 'cloudformation deploy' no reemplaza el código cuando sólo cambió el contenido del .zip:
# la key de S3 es la misma, así que el recurso le parece idéntico. Hay que forzarlo.
echo "==> Actualizando el código de la función"
"${AWSX[@]}" lambda update-function-code \
  --function-name "$NAME_PREFIX-updater" \
  --s3-bucket "$DEPLOYMENT_BUCKET" --s3-key "$S3_KEY" \
  --query 'LastModified' --output text
"${AWSX[@]}" lambda wait function-updated --function-name "$NAME_PREFIX-updater"

echo "==> Listo. './deploy.sh invoke' para probarla, './deploy.sh logs' para ver la salida."
