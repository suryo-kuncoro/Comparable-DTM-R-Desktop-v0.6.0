json_escape <- function(x) {
  x <- as.character(x)
  x <- gsub("\\\\", "\\\\\\\\", x)
  x <- gsub("\"", "\\\\\"", x)
  x <- gsub("\r", "\\\\r", x)
  x <- gsub("\n", "\\\\n", x)
  x
}

emit <- function(type, percent=NULL, stage=NULL, message=NULL, level="info") {
  parts <- c(paste0('"type":"', json_escape(type), '"'))
  if (!is.null(percent)) parts <- c(parts, paste0('"percent":', as.numeric(percent)))
  if (!is.null(stage)) parts <- c(parts, paste0('"stage":"', json_escape(stage), '"'))
  if (!is.null(message)) parts <- c(parts, paste0('"message":"', json_escape(message), '"'))
  if (!is.null(level)) parts <- c(parts, paste0('"level":"', json_escape(level), '"'))
  cat("APP_EVENT: {", paste(parts, collapse=","), "}\n", sep="")
  flush.console()
}

emit("progress", 10, "R Environment", paste0("R: ", R.version.string))

if (!requireNamespace("terra", quietly=TRUE)) {
  emit("fatal", 100, "Environment failed",
       "Package 'terra' tidak tersedia. Package ini wajib untuk GCP dan input raster.",
       "error")
  quit(status=1)
}

terra_version <- as.character(utils::packageVersion("terra"))
emit("progress", 55, "R Environment",
     paste0("terra tersedia, versi ", terra_version), "success")

if (requireNamespace("lidR", quietly=TRUE)) {
  lidr_version <- as.character(utils::packageVersion("lidR"))
  emit("progress", 80, "R Environment",
       paste0("lidR tersedia, versi ", lidr_version, ". LAS/LAZ siap digunakan."),
       "success")
} else {
  emit("log", NULL, "R Environment",
       "lidR tidak tersedia. Mode DTM raster tetap dapat digunakan; LAS/LAZ akan ditolak saat validasi.",
       "warning")
}

emit("progress", 100, "Environment ready",
     "Environment check selesai.", "success")
