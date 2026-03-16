output "backend_url" {
  description = "Cloud Run backend URL"
  value       = google_cloud_run_v2_service.backend.uri
}

output "frontend_url" {
  description = "Cloud Run frontend URL"
  value       = google_cloud_run_v2_service.frontend.uri
}

output "registry" {
  description = "Artifact Registry path for pushing images"
  value       = local.registry
}

output "firestore_database" {
  description = "Firestore database name"
  value       = google_firestore_database.main.name
}
