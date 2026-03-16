variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "image_tag" {
  description = "Docker image tag to deploy (e.g. git commit SHA)"
  type        = string
  default     = "latest"
}

variable "frontend_domain" {
  description = "Custom frontend domain for CORS (leave empty to allow all)"
  type        = string
  default     = ""
}
