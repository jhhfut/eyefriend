terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Enable required APIs ───────────────────────────────────────────────────────

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudbuild" {
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

# ── Firestore database ─────────────────────────────────────────────────────────

resource "google_firestore_database" "main" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]
}

# ── Artifact Registry repository ───────────────────────────────────────────────

resource "google_artifact_registry_repository" "repo" {
  repository_id = "eyefriend"
  format        = "DOCKER"
  location      = var.region

  depends_on = [google_project_service.artifactregistry]
}

locals {
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/eyefriend"
}

# ── Service account for backend ────────────────────────────────────────────────

resource "google_service_account" "backend" {
  account_id   = "eyefriend-backend"
  display_name = "EyeFriend Backend"
}

resource "google_project_iam_member" "backend_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.backend.email}"
}

# ── Cloud Run: Backend ─────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "backend" {
  name     = "eyefriend-backend"
  location = var.region

  template {
    service_account = google_service_account.backend.email

    containers {
      image = "${local.registry}/backend:${var.image_tag}"

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "ALLOWED_ORIGIN"
        value = "https://${var.frontend_domain != "" ? var.frontend_domain : "*"}"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
  }

  depends_on = [
    google_project_service.run,
    google_artifact_registry_repository.repo,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = google_cloud_run_v2_service.backend.project
  location = google_cloud_run_v2_service.backend.location
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Run: Frontend ────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "frontend" {
  name     = "eyefriend-frontend"
  location = var.region

  template {
    containers {
      image = "${local.registry}/frontend:${var.image_tag}"

      env {
        name  = "VITE_BACKEND_URL"
        value = google_cloud_run_v2_service.backend.uri
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
  }

  depends_on = [
    google_project_service.run,
    google_artifact_registry_repository.repo,
    google_cloud_run_v2_service.backend,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  project  = google_cloud_run_v2_service.frontend.project
  location = google_cloud_run_v2_service.frontend.location
  name     = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
