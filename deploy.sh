#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# EyeFriend — automated deployment script
# Builds Docker images, pushes to Artifact Registry, then runs Terraform
#
# Usage:
#   export GOOGLE_CLOUD_PROJECT=your-project-id
#   export GEMINI_API_KEY=your-key
#   ./deploy.sh
#
# Prerequisites: gcloud CLI (authenticated), docker, terraform
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${REGION:-us-central1}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/eyefriend"

echo "==> Project : ${PROJECT_ID}"
echo "==> Region  : ${REGION}"
echo "==> Tag     : ${IMAGE_TAG}"

# ── 1. Authenticate Docker with Artifact Registry ─────────────────────────────
echo ""
echo "==> [1/4] Configuring Docker auth..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── 2. Enable APIs (idempotent) ───────────────────────────────────────────────
echo ""
echo "==> [2/4] Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}" --quiet

# Create Artifact Registry repo if it doesn't exist
gcloud artifacts repositories create eyefriend \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" 2>/dev/null || true

# ── 3. Build & push Docker images ────────────────────────────────────────────
echo ""
echo "==> [3/4] Building and pushing Docker images..."

GEMINI_API_KEY="${GEMINI_API_KEY:-}"

# Backend
docker build -t "${REGISTRY}/backend:${IMAGE_TAG}" ./backend
docker push "${REGISTRY}/backend:${IMAGE_TAG}"
echo "   backend  → ${REGISTRY}/backend:${IMAGE_TAG}"

# Frontend (needs GEMINI_API_KEY + placeholder VITE_BACKEND_URL at build time)
docker build \
  --build-arg GEMINI_API_KEY="${GEMINI_API_KEY}" \
  --build-arg VITE_BACKEND_URL="__BACKEND_URL_PLACEHOLDER__" \
  -t "${REGISTRY}/frontend:${IMAGE_TAG}" .
docker push "${REGISTRY}/frontend:${IMAGE_TAG}"
echo "   frontend → ${REGISTRY}/frontend:${IMAGE_TAG}"

# ── 4. Terraform apply ────────────────────────────────────────────────────────
echo ""
echo "==> [4/4] Running Terraform..."
cd terraform

# Write tfvars
cat > terraform.tfvars <<EOF
project_id = "${PROJECT_ID}"
region     = "${REGION}"
image_tag  = "${IMAGE_TAG}"
EOF

terraform init -upgrade -reconfigure \
  -backend-config="bucket=${PROJECT_ID}-tfstate" 2>/dev/null || terraform init -upgrade

terraform apply -auto-approve \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="image_tag=${IMAGE_TAG}"

BACKEND_URL=$(terraform output -raw backend_url)
FRONTEND_URL=$(terraform output -raw frontend_url)

cd ..

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  EyeFriend — Deployment complete!                    ║"
echo "║                                                      ║"
printf  "║  Frontend : %-40s║\n" "${FRONTEND_URL}"
printf  "║  Backend  : %-40s║\n" "${BACKEND_URL}"
echo "╚══════════════════════════════════════════════════════╝"
