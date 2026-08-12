args <- commandArgs(trailingOnly=TRUE)

if (length(args) < 2) stop("Usage: Rscript pipeline.R <validate|run> <runtime_config.tsv>")

mode <- args[1]
config_path <- args[2]
if (!mode %in% c("validate","run")) stop("Mode harus validate atau run.")

json_escape <- function(x) {
  x <- as.character(x)
  x <- gsub("\\\\", "\\\\\\\\", x)
  x <- gsub("\"", "\\\\\"", x)
  x <- gsub("\r", "\\\\r", x)
  x <- gsub("\n", "\\\\n", x)
  x
}
json_string <- function(x) paste0('"', json_escape(x), '"')
json_number <- function(x) {
  x <- as.numeric(x)
  if (length(x)==0 || !is.finite(x)) "null"
  else format(x, scientific=FALSE, trim=TRUE, digits=15)
}

emit <- function(type, percent=NULL, stage=NULL, message=NULL, level="info") {
  parts <- c(paste0('"type":"', json_escape(type), '"'))
  if (!is.null(percent)) parts <- c(parts, paste0('"percent":', as.numeric(percent)))
  if (!is.null(stage)) parts <- c(parts, paste0('"stage":"', json_escape(stage), '"'))
  if (!is.null(message)) parts <- c(parts, paste0('"message":"', json_escape(message), '"'))
  if (!is.null(level)) parts <- c(parts, paste0('"level":"', json_escape(level), '"'))

  line <- paste0("APP_EVENT: {", paste(parts, collapse=","), "}")
  cat(line, "\n", sep="")
  flush.console()

  if (exists("log_path", inherits=TRUE) && nzchar(log_path)) {
    cat(
      format(Sys.time(), "%Y-%m-%d %H:%M:%S"), " | ", toupper(level), " | ",
      ifelse(is.null(stage), "", stage), " | ",
      ifelse(is.null(message), "", message), "\n",
      sep="", file=log_path, append=TRUE
    )
  }
}

fatal <- function(message) {
  emit("fatal", 100, "Fatal", message, "error")
  stop(message, call.=FALSE)
}

if (!file.exists(config_path)) stop(paste0("Runtime config tidak ditemukan: ", config_path))

cfg_df <- read.delim(
  config_path, sep="\t", header=TRUE, quote="",
  stringsAsFactors=FALSE, check.names=FALSE
)
if (!all(c("key","value") %in% names(cfg_df))) stop("runtime_config.tsv tidak valid.")
cfg <- as.list(setNames(cfg_df$value, cfg_df$key))

get_cfg <- function(key, default="") {
  value <- cfg[[key]]
  if (is.null(value) || is.na(value) || !nzchar(as.character(value))) default else as.character(value)
}

model1_name <- trimws(get_cfg("model1_name"))
model1_path <- get_cfg("model1_path")
model2_name <- trimws(get_cfg("model2_name"))
model2_path <- get_cfg("model2_path")
gcp_path <- get_cfg("gcp_path")
z_field <- trimws(get_cfg("z_field"))
run_dir <- get_cfg("run_dir")

extraction_method <- get_cfg("extraction_method","simple")
pc_estimator <- get_cfg("pc_estimator","idw")
pc_search_radius <- suppressWarnings(as.numeric(get_cfg("pc_search_radius","2")))
pc_k <- suppressWarnings(as.integer(get_cfg("pc_k","8")))
pc_power <- suppressWarnings(as.numeric(get_cfg("pc_power","2")))
pc_ground_rule <- get_cfg("pc_ground_rule","auto")

log_path <- if (mode=="run") file.path(run_dir,"analysis.log") else ""

if (mode=="run") {
  dir.create(run_dir, recursive=TRUE, showWarnings=FALSE)
  cat(
    "Comparable DTM R v0.6.0 analysis log\n",
    "Started: ", format(Sys.time(), "%Y-%m-%d %H:%M:%S"), "\n\n",
    sep="", file=log_path
  )
}

if (!requireNamespace("terra", quietly=TRUE)) fatal("Package 'terra' tidak tersedia.")
library(terra)

input_type <- function(path) {
  ext <- tolower(tools::file_ext(path))
  if (ext %in% c("tif","tiff")) return("raster")
  if (ext %in% c("las","laz")) return("pointcloud")
  "unknown"
}

type1 <- input_type(model1_path)
type2 <- input_type(model2_path)
uses_pointcloud <- any(c(type1,type2)=="pointcloud")

if (uses_pointcloud && !requireNamespace("lidR", quietly=TRUE)) {
  fatal(
    paste(
      "Salah satu input berupa LAS/LAZ tetapi package 'lidR' tidak tersedia.",
      "Pilih Rscript yang menggunakan environment lidR yang sudah disiapkan."
    )
  )
}

if (uses_pointcloud && !requireNamespace("sf", quietly=TRUE)) {
  fatal("Package 'sf' tidak tersedia. Package ini diperlukan oleh workflow lidR untuk CRS point cloud.")
}

if (!nzchar(model1_name)) fatal("Nama Model 1 kosong.")
if (!nzchar(model2_name)) fatal("Nama Model 2 kosong.")
if (tolower(model1_name)==tolower(model2_name)) fatal("Nama kedua model harus berbeda.")

for (item in list(
  c(model1_path,"Input Model 1"),
  c(model2_path,"Input Model 2"),
  c(gcp_path,"GCP")
)) {
  if (!nzchar(item[1]) || !file.exists(item[1])) fatal(paste0(item[2]," tidak ditemukan: ",item[1]))
}

if (type1=="unknown") fatal("Input Model 1 harus .tif/.tiff/.las/.laz.")
if (type2=="unknown") fatal("Input Model 2 harus .tif/.tiff/.las/.laz.")
if (!extraction_method %in% c("simple","bilinear")) fatal("Raster extraction method tidak valid.")
if (!pc_estimator %in% c("idw","nearest")) fatal("Point cloud estimator tidak valid.")
if (!is.finite(pc_search_radius) || pc_search_radius<=0) fatal("Point cloud search radius harus > 0.")
if (is.na(pc_k) || pc_k<1) fatal("Point cloud k harus >= 1.")
if (!is.finite(pc_power) || pc_power<=0) fatal("IDW power harus > 0.")
if (!pc_ground_rule %in% c("auto","class2","all")) fatal("Point cloud ground rule tidak valid.")

safe_numeric <- function(x, field_name) {
  out <- suppressWarnings(as.numeric(x))
  if (all(is.na(out))) fatal(paste0("Field '",field_name,"' tidak dapat dibaca sebagai angka."))
  out
}

safe_id <- function(gcp) {
  candidates <- c("ID","Id","id","GCP_ID","gcp_id","POINT_ID","Point_ID","Name","NAME","nama","Kode","KODE")
  for (field in candidates) {
    if (field %in% names(gcp)) {
      val <- as.character(gcp[[field]][,1])
      if (length(val)==nrow(gcp)) return(val)
    }
  }
  as.character(seq_len(nrow(gcp)))
}

metrics <- function(model, ref) {
  ok <- is.finite(model) & is.finite(ref)
  model <- model[ok]; ref <- ref[ok]
  if (length(ref)==0) return(c(
    n=0,bias=NA,rmse=NA,sd=NA,mae=NA,median_error=NA,r2=NA,
    le90=NA,le95=NA,min_residual=NA,max_residual=NA
  ))
  res <- model-ref
  r2 <- if (
    length(ref)>1 && is.finite(sd(ref)) && is.finite(sd(model)) &&
    sd(ref)>0 && sd(model)>0
  ) cor(model,ref)^2 else NA_real_
  c(
    n=length(res),
    bias=mean(res),
    rmse=sqrt(mean(res^2)),
    sd=if(length(res)>1) sd(res) else NA_real_,
    mae=mean(abs(res)),
    median_error=median(res),
    r2=r2,
    le90=quantile(abs(res),.90,na.rm=TRUE,names=FALSE,type=7),
    le95=quantile(abs(res),.95,na.rm=TRUE,names=FALSE,type=7),
    min_residual=min(res),
    max_residual=max(res)
  )
}

extract_raster <- function(path, gcp) {
  r <- tryCatch(rast(path), error=function(e) fatal(paste("Raster gagal dibaca:",e$message)))
  if (nlyr(r)<1) fatal("Raster tidak memiliki layer.")
  if (!nzchar(crs(r))) fatal(paste0("CRS raster kosong: ",basename(path)))
  if (!nzchar(crs(gcp))) fatal("CRS GCP kosong.")
  gp <- gcp
  if (!isTRUE(tryCatch(same.crs(gp,r),error=function(e) FALSE))) gp <- project(gp,crs(r))
  vals <- extract(r[[1]],gp,method=extraction_method)
  if (ncol(vals)<2) fatal("Ekstraksi raster gagal.")
  list(
    z=as.numeric(vals[[2]]),
    details=paste0("Raster ",extraction_method),
    pc_ground_mode=NA_character_
  )
}

pc_crs_wkt <- function(ctg) {
  wkt <- tryCatch(sf::st_crs(ctg)$wkt, error=function(e) NA_character_)
  if (length(wkt)==0 || is.na(wkt) || !nzchar(wkt)) {
    epsg <- tryCatch(sf::st_crs(ctg)$epsg, error=function(e) NA_integer_)
    if (length(epsg) && is.finite(epsg)) return(paste0("EPSG:",epsg))
    return("")
  }
  wkt
}

las_payload <- function(las) {
  if (is.null(las)) return(NULL)
  if (exists("payload", where=asNamespace("lidR"), inherits=FALSE)) {
    fun <- get("payload", envir=asNamespace("lidR"))
    return(tryCatch(fun(las), error=function(e) NULL))
  }
  tryCatch(las@data, error=function(e) NULL)
}

classification_col <- function(d) {
  nm <- names(d)
  candidates <- c("Classification","classification","CLASSIFICATION")
  found <- candidates[candidates %in% nm]
  if (length(found)) found[1] else NA_character_
}

choose_ground_mode <- function(rois, rule, model_name) {
  if (rule=="all") return("all")
  if (rule=="class2") return("class2")

  all_classes <- integer(0)
  has_class_column <- FALSE

  for (roi in rois) {
    d <- las_payload(roi)
    if (is.null(d) || nrow(d)==0) next
    ccol <- classification_col(d)
    if (!is.na(ccol)) {
      has_class_column <- TRUE
      vals <- suppressWarnings(as.integer(d[[ccol]]))
      vals <- vals[is.finite(vals)]
      all_classes <- c(all_classes, unique(vals))
    }
  }

  all_classes <- sort(unique(all_classes))

  if (2L %in% all_classes) return("class2")

  if (!has_class_column) {
    emit("log",NULL,"Point Cloud",
         paste0(model_name, ": Classification tidak tersedia; diasumsikan ground-only dan semua titik digunakan."),
         "warning")
    return("all")
  }

  if (length(all_classes)<=1) {
    emit("log",NULL,"Point Cloud",
         paste0(model_name, ": tidak ada Class 2 dan hanya satu kelas terdeteksi (",
                paste(all_classes,collapse=","), "); diasumsikan ground-only."),
         "warning")
    return("all")
  }

  fatal(
    paste0(
      model_name, ": point cloud memiliki beberapa kelas (",
      paste(all_classes,collapse=","),
      ") tetapi Class 2 tidak ditemukan pada neighborhood GCP. ",
      "Pilih 'Use all points' hanya jika file memang ground-only."
    )
  )
}

estimate_z_from_roi <- function(roi, x0, y0, ground_mode) {
  d <- las_payload(roi)
  if (is.null(d) || nrow(d)==0) return(NA_real_)

  if (!all(c("X","Y","Z") %in% names(d))) return(NA_real_)

  if (ground_mode=="class2") {
    ccol <- classification_col(d)
    if (is.na(ccol)) return(NA_real_)
    keep <- suppressWarnings(as.integer(d[[ccol]]))==2L
    keep[is.na(keep)] <- FALSE
    d <- d[keep, , drop=FALSE]
    if (nrow(d)==0) return(NA_real_)
  }

  dx <- as.numeric(d$X)-x0
  dy <- as.numeric(d$Y)-y0
  dist2 <- dx*dx + dy*dy
  ok <- is.finite(dist2) & is.finite(as.numeric(d$Z))
  if (!any(ok)) return(NA_real_)

  dist2 <- dist2[ok]
  z <- as.numeric(d$Z)[ok]

  ord <- order(dist2)
  if (pc_estimator=="nearest") return(z[ord[1]])

  nkeep <- min(pc_k,length(ord))
  ord <- ord[seq_len(nkeep)]
  dsel <- sqrt(dist2[ord])
  zsel <- z[ord]

  exact <- which(dsel <= .Machine$double.eps^0.5)
  if (length(exact)) return(mean(zsel[exact]))

  w <- 1/(dsel^pc_power)
  if (!all(is.finite(w)) || sum(w)<=0) return(NA_real_)
  sum(w*zsel)/sum(w)
}

extract_pointcloud <- function(path, gcp, model_name) {
  emit("log",NULL,"Point Cloud",paste0(model_name, ": membaca LAScatalog dan CRS..."))

  ctg <- tryCatch(
    lidR::readLAScatalog(path),
    error=function(e) fatal(paste0(model_name, ": LAS/LAZ gagal dibaca: ",e$message))
  )

  pc_crs <- pc_crs_wkt(ctg)
  if (!nzchar(pc_crs)) fatal(paste0(model_name, ": CRS point cloud kosong/tidak dapat dibaca."))
  if (!nzchar(crs(gcp))) fatal("CRS GCP kosong.")

  gp <- tryCatch(
    project(gcp,pc_crs),
    error=function(e) fatal(paste0(model_name, ": GCP gagal diproyeksikan ke CRS point cloud: ",e$message))
  )

  xy <- crds(gp,df=TRUE)
  if (!all(c("x","y") %in% names(xy))) {
    # terra may return X/Y depending version
    names(xy)[1:2] <- c("x","y")
  }

  # Only attributes needed. xyz are implicit; c requests Classification.
  try(lidR::opt_select(ctg) <- "c", silent=TRUE)
  try(lidR::opt_output_files(ctg) <- "", silent=TRUE)

  emit(
    "log",NULL,"Point Cloud",
    paste0(
      model_name, ": clipping neighborhood radius ",pc_search_radius,
      " m untuk ",nrow(xy)," GCP."
    )
  )

  rois <- tryCatch(
    lidR::clip_circle(ctg, x=xy$x, y=xy$y, radius=pc_search_radius),
    error=function(e) fatal(paste0(model_name, ": clip_circle gagal: ",e$message))
  )

  if (inherits(rois,"LAS")) rois <- list(rois)
  if (!is.list(rois)) rois <- as.list(rois)

  if (length(rois)!=nrow(xy)) {
    # Some old lidR versions may drop empty ROI. Fall back per-point extraction.
    rois <- vector("list",nrow(xy))
    for (i in seq_len(nrow(xy))) {
      rois[[i]] <- tryCatch(
        lidR::clip_circle(ctg, x=xy$x[i], y=xy$y[i], radius=pc_search_radius),
        error=function(e) NULL
      )
    }
  }

  ground_mode <- choose_ground_mode(rois,pc_ground_rule,model_name)
  emit(
    "log",NULL,"Point Cloud",
    paste0(model_name, ": ground mode = ",ground_mode,
           "; estimator = ",pc_estimator,
           if(pc_estimator=="idw") paste0(" (k=",pc_k,", p=",pc_power,")") else ""),
    "success"
  )

  z <- rep(NA_real_,nrow(xy))
  point_counts <- integer(nrow(xy))

  for (i in seq_len(nrow(xy))) {
    roi <- rois[[i]]
    d <- las_payload(roi)
    point_counts[i] <- if (is.null(d)) 0L else nrow(d)
    z[i] <- estimate_z_from_roi(roi,xy$x[i],xy$y[i],ground_mode)
  }

  list(
    z=z,
    details=paste0(
      "Point cloud ",pc_estimator,
      " | radius=",pc_search_radius,"m",
      if(pc_estimator=="idw") paste0(" | k=",pc_k," | p=",pc_power) else ""
    ),
    pc_ground_mode=ground_mode,
    neighborhood_points=point_counts
  )
}

extract_model <- function(path, type, gcp, model_name) {
  if (type=="raster") return(extract_raster(path,gcp))
  if (type=="pointcloud") return(extract_pointcloud(path,gcp,model_name))
  fatal(paste0(model_name, ": tipe input tidak didukung."))
}

emit("progress",5,"Reference","Membaca GCP...")

gcp <- tryCatch(vect(gcp_path),error=function(e) fatal(paste("GCP gagal dibaca:",e$message)))
if (nrow(gcp)<2) fatal("GCP harus memiliki minimal 2 titik.")
gt <- tryCatch(tolower(geomtype(gcp)),error=function(e) "")
if (length(gt) && !all(gt %in% c("points","point"))) fatal("Geometry GCP harus titik.")
if (!(z_field %in% names(gcp))) {
  fatal(paste0("Field Z '",z_field,"' tidak ditemukan. Field tersedia: ",paste(names(gcp),collapse=", ")))
}
if (!nzchar(crs(gcp))) fatal("CRS GCP kosong.")

z_ref <- safe_numeric(gcp[[z_field]][,1],z_field)
if (sum(is.finite(z_ref))<2) fatal("Elevasi referensi valid kurang dari 2 GCP.")

emit("progress",12,"Model 1",paste0("Memproses ",model1_name," [",type1,"]..."))
res1 <- extract_model(model1_path,type1,gcp,model1_name)

emit("progress",34,"Model 2",paste0("Memproses ",model2_name," [",type2,"]..."))
res2 <- extract_model(model2_path,type2,gcp,model2_name)

z1 <- res1$z
z2 <- res2$z
if (length(z1)!=length(z_ref) || length(z2)!=length(z_ref)) fatal("Jumlah hasil sampling tidak sama dengan jumlah GCP.")

common <- is.finite(z_ref) & is.finite(z1) & is.finite(z2)
common_n <- sum(common)
total_gcp <- length(z_ref)

if (common_n<2) {
  fatal(paste0(
    "Common valid GCP kurang dari 2. Model 1 valid: ",sum(is.finite(z1)&is.finite(z_ref)),
    ", Model 2 valid: ",sum(is.finite(z2)&is.finite(z_ref)),
    ", common: ",common_n,"."
  ))
}

emit("progress",52,"Common GCP",
     paste0("Common valid GCP: ",common_n," / ",total_gcp,"."),"success")

m1 <- metrics(z1[common],z_ref[common])
m2 <- metrics(z2[common],z_ref[common])

rmse1 <- as.numeric(m1["rmse"]); rmse2 <- as.numeric(m2["rmse"])
delta_rmse <- abs(rmse1-rmse2)

if (abs(rmse1-rmse2)<sqrt(.Machine$double.eps)) {
  winner <- "Setara"
  winner_reason <- paste0("RMSE kedua model praktis sama: ",round(rmse1,4),".")
} else if (rmse1<rmse2) {
  winner <- model1_name
  winner_reason <- paste0("RMSE ",model1_name," lebih kecil (",round(rmse1,4)," vs ",round(rmse2,4),
                          "), selisih ",round(delta_rmse,4),".")
} else {
  winner <- model2_name
  winner_reason <- paste0("RMSE ",model2_name," lebih kecil (",round(rmse2,4)," vs ",round(rmse1,4),
                          "), selisih ",round(delta_rmse,4),".")
}

emit("progress",60,"Metrics",paste0("Metrik selesai. Best RMSE: ",winner),"success")

if (mode=="validate") {
  emit(
    "progress",100,"Validation complete",
    paste0(
      "Input valid | ",model1_name,": ",type1," | ",model2_name,": ",type2,
      " | common GCP: ",common_n,"/",total_gcp
    ),
    "success"
  )
  quit(status=0)
}

id <- safe_id(gcp)

point_table <- data.frame(
  GCP_ID=id,
  Z_Referensi=z_ref,
  Z_Model_1=z1,
  Residual_Model_1=z1-z_ref,
  AbsResidual_Model_1=abs(z1-z_ref),
  Z_Model_2=z2,
  Residual_Model_2=z2-z_ref,
  AbsResidual_Model_2=abs(z2-z_ref),
  Valid_Common=common,
  stringsAsFactors=FALSE
)

if (!is.null(res1$neighborhood_points)) point_table$NeighborhoodPoints_Model_1 <- res1$neighborhood_points
if (!is.null(res2$neighborhood_points)) point_table$NeighborhoodPoints_Model_2 <- res2$neighborhood_points

summary_table <- data.frame(
  Model=c(model1_name,model2_name),
  Input_Type=c(type1,type2),
  Processing=c(res1$details,res2$details),
  PointCloud_Ground_Mode=c(res1$pc_ground_mode,res2$pc_ground_mode),
  N_Common=c(m1["n"],m2["n"]),
  Bias=c(m1["bias"],m2["bias"]),
  RMSE=c(m1["rmse"],m2["rmse"]),
  SD=c(m1["sd"],m2["sd"]),
  MAE=c(m1["mae"],m2["mae"]),
  Median_Error=c(m1["median_error"],m2["median_error"]),
  R2=c(m1["r2"],m2["r2"]),
  LE90=c(m1["le90"],m2["le90"]),
  LE95=c(m1["le95"],m2["le95"]),
  Min_Residual=c(m1["min_residual"],m2["min_residual"]),
  Max_Residual=c(m1["max_residual"],m2["max_residual"]),
  stringsAsFactors=FALSE
)
summary_table$Rank_RMSE <- rank(summary_table$RMSE,ties.method="min",na.last="keep")
summary_table <- summary_table[,c(
  "Rank_RMSE","Model","Input_Type","Processing","PointCloud_Ground_Mode",
  "N_Common","Bias","RMSE","SD","MAE","Median_Error","R2","LE90","LE95",
  "Min_Residual","Max_Residual"
)]

write.csv(point_table,file.path(run_dir,"comparison_points.csv"),row.names=FALSE,na="")
write.csv(summary_table,file.path(run_dir,"summary_metrics.csv"),row.names=FALSE,na="")

emit("progress",68,"GIS Output","Menulis residual GCP ke GeoPackage...")

gcp_out <- gcp
gcp_out$GCP_ID <- id
gcp_out$Z_Ref <- z_ref
gcp_out$Z_Model1 <- z1
gcp_out$Res_Model1 <- z1-z_ref
gcp_out$Z_Model2 <- z2
gcp_out$Res_Model2 <- z2-z_ref
gcp_out$ValidBoth <- common

tryCatch(
  writeVector(gcp_out,file.path(run_dir,"gcp_residuals.gpkg"),filetype="GPKG",overwrite=TRUE),
  error=function(e) emit("log",NULL,"GIS Output",paste("Warning GPKG:",e$message),"warning")
)

emit("progress",74,"QC Plot","Membuat grafik QC...")

png(file.path(run_dir,"qc_rmse_comparison.png"),width=1200,height=720,res=130)
par(mar=c(6,5,4,2))
bp <- barplot(
  c(rmse1,rmse2), names.arg=c(model1_name,model2_name),
  ylab="RMSE", main="Perbandingan RMSE terhadap GCP", las=2,
  col=c("#4FD19B","#5DA8FF")
)
text(bp,c(rmse1,rmse2),labels=round(c(rmse1,rmse2),4),pos=3,cex=.9)
dev.off()

png(file.path(run_dir,"qc_scatter_model1.png"),width=900,height=820,res=130)
plot(z_ref[common],z1[common],pch=19,col=rgb(.20,.72,.49,.65),
     xlab="Z Referensi GCP",ylab=paste0("Z ",model1_name),
     main=paste0("Reference vs ",model1_name," [",type1,"]"))
abline(0,1,lty=2,lwd=2,col="#555555"); grid(); dev.off()

png(file.path(run_dir,"qc_scatter_model2.png"),width=900,height=820,res=130)
plot(z_ref[common],z2[common],pch=19,col=rgb(.22,.56,.95,.65),
     xlab="Z Referensi GCP",ylab=paste0("Z ",model2_name),
     main=paste0("Reference vs ",model2_name," [",type2,"]"))
abline(0,1,lty=2,lwd=2,col="#555555"); grid(); dev.off()

png(file.path(run_dir,"qc_residual_boxplot.png"),width=1100,height=720,res=130)
boxplot(
  list(Model1=(z1-z_ref)[common],Model2=(z2-z_ref)[common]),
  names=c(model1_name,model2_name),ylab="Residual (Z model - Z referensi)",
  main="Distribusi Residual",col=c("#4FD19B","#5DA8FF"),las=2
)
abline(h=0,lty=2,col="#555555"); grid(); dev.off()

emit("progress",84,"Report","Menyusun summary dan HTML report...")

summary_json <- paste0(
  "{\n",
  '  "app":"Comparable DTM R",\n',
  '  "version":"0.6.0",\n',
  '  "generated_at":',json_string(format(Sys.time(),"%Y-%m-%d %H:%M:%S")),",\n",
  '  "winner":',json_string(winner),",\n",
  '  "winner_reason":',json_string(winner_reason),",\n",
  '  "total_gcp":',total_gcp,",\n",
  '  "common_valid_gcp":',common_n,",\n",
  '  "delta_rmse":',json_number(delta_rmse),",\n",
  '  "model1":{\n',
  '    "name":',json_string(model1_name),",\n",
  '    "input_type":',json_string(type1),",\n",
  '    "processing":',json_string(res1$details),",\n",
  '    "ground_mode":',json_string(ifelse(is.na(res1$pc_ground_mode),"",res1$pc_ground_mode)),",\n",
  '    "bias":',json_number(m1["bias"]),",\n",
  '    "rmse":',json_number(m1["rmse"]),",\n",
  '    "sd":',json_number(m1["sd"]),",\n",
  '    "mae":',json_number(m1["mae"]),",\n",
  '    "r2":',json_number(m1["r2"]),",\n",
  '    "le90":',json_number(m1["le90"]),",\n",
  '    "le95":',json_number(m1["le95"]),"\n",
  "  },\n",
  '  "model2":{\n',
  '    "name":',json_string(model2_name),",\n",
  '    "input_type":',json_string(type2),",\n",
  '    "processing":',json_string(res2$details),",\n",
  '    "ground_mode":',json_string(ifelse(is.na(res2$pc_ground_mode),"",res2$pc_ground_mode)),",\n",
  '    "bias":',json_number(m2["bias"]),",\n",
  '    "rmse":',json_number(m2["rmse"]),",\n",
  '    "sd":',json_number(m2["sd"]),",\n",
  '    "mae":',json_number(m2["mae"]),",\n",
  '    "r2":',json_number(m2["r2"]),",\n",
  '    "le90":',json_number(m2["le90"]),",\n",
  '    "le95":',json_number(m2["le95"]),"\n",
  "  }\n",
  "}\n"
)
writeLines(summary_json,file.path(run_dir,"result_summary.json"),useBytes=TRUE)

html_escape <- function(x) {
  x <- gsub("&","&amp;",as.character(x),fixed=TRUE)
  x <- gsub("<","&lt;",x,fixed=TRUE)
  x <- gsub(">","&gt;",x,fixed=TRUE)
  x
}
metric_rows <- apply(summary_table,1,function(r) paste0(
  "<tr>",
  "<td>",html_escape(r[["Rank_RMSE"]]),"</td>",
  "<td>",html_escape(r[["Model"]]),"</td>",
  "<td>",html_escape(r[["Input_Type"]]),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["Bias"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["RMSE"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["SD"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["MAE"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["R2"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["LE90"]])),"</td>",
  "<td>",sprintf("%.4f",as.numeric(r[["LE95"]])),"</td>",
  "</tr>"
))

report <- paste0(
'<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>Comparable DTM R Report</title>
<style>
body{margin:0;background:#0b0f11;color:#eaf2ef;font-family:Segoe UI,Arial,sans-serif}
.wrap{max-width:1180px;margin:30px auto;padding:0 22px}
.hero{padding:28px;border:1px solid #253034;border-radius:20px;background:linear-gradient(145deg,#123327,#101619)}
.hero small{color:#4fd19b;font-weight:800;letter-spacing:1px}.hero h1{font-size:38px;margin:8px 0}.hero p{color:#93a49d;margin:0}
.grid{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:14px;margin-top:16px}
.card{background:#11181b;border:1px solid #253034;border-radius:16px;padding:20px;margin-top:16px}
.grid .card{margin-top:0}.winner{font-size:28px;color:#4fd19b;font-weight:800;margin:8px 0}
.big{font-size:24px;font-weight:800;margin:8px 0}.muted{color:#8fa09a}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th,td{padding:10px;border-bottom:1px solid #253034;text-align:right}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}
th{color:#4fd19b;background:#0e1517}img{width:100%;height:auto;border-radius:12px;border:1px solid #253034}
.images{display:grid;grid-template-columns:1fr 1fr;gap:14px}code{color:#80dcb4}
@media(max-width:850px){.grid,.images{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<section class="hero"><small>PMNP · GEOSPATIAL QUALITY CONTROL</small>
<h1>Comparable DTM R v0.6.0</h1>
<p>DTM raster dan final/classified point cloud dibandingkan langsung terhadap GCP.</p></section>
<section class="grid">
<div class="card"><div class="muted">BEST RMSE</div><div class="winner">',html_escape(winner),'</div><div class="muted">',html_escape(winner_reason),'</div></div>
<div class="card"><div class="muted">MODEL 1</div><div class="big">',html_escape(model1_name),'</div><div class="muted">',html_escape(type1),' · ',html_escape(res1$details),'</div></div>
<div class="card"><div class="muted">MODEL 2</div><div class="big">',html_escape(model2_name),'</div><div class="muted">',html_escape(type2),' · ',html_escape(res2$details),'</div></div>
</section>
<section class="card"><h2>Ringkasan Metrik</h2><table>
<thead><tr><th>Rank</th><th>Model</th><th>Input</th><th>Bias</th><th>RMSE</th><th>SD</th><th>MAE</th><th>R²</th><th>LE90</th><th>LE95</th></tr></thead>
<tbody>',paste(metric_rows,collapse="\n"),'</tbody></table></section>
<section class="card"><h2>Common GCP</h2><p class="muted">Ranking menggunakan ',common_n,' dari ',total_gcp,' GCP yang valid pada kedua model dan referensi.</p></section>
<section class="card"><h2>QC Graphics</h2><div class="images">
<div><img src="qc_rmse_comparison.png"></div><div><img src="qc_residual_boxplot.png"></div>
<div><img src="qc_scatter_model1.png"></div><div><img src="qc_scatter_model2.png"></div>
</div></section>
<section class="card"><h2>Metodologi Input</h2><p class="muted">
Raster menggunakan <code>terra::extract</code>. Point cloud LAS/LAZ tidak dirasterkan:
aplikasi membaca neighborhood ground points di sekitar GCP dan mengestimasi Z secara langsung.
Residual = Z model - Z referensi.</p></section>
</div></body></html>'
)
writeLines(report,file.path(run_dir,"report.html"),useBytes=TRUE)

emit("progress",92,"Manifest","Membuat output manifest...")

manifest_files <- c(
  "run_config.json","runtime_config.tsv","analysis.log",
  "comparison_points.csv","summary_metrics.csv","gcp_residuals.gpkg",
  "qc_rmse_comparison.png","qc_scatter_model1.png","qc_scatter_model2.png",
  "qc_residual_boxplot.png","result_summary.json","report.html"
)
manifest_paths <- file.path(run_dir,manifest_files)
manifest <- data.frame(
  file=manifest_files,
  exists=file.exists(manifest_paths),
  size_bytes=ifelse(file.exists(manifest_paths),file.info(manifest_paths)$size,NA),
  stringsAsFactors=FALSE
)
write.csv(manifest,file.path(run_dir,"output_manifest.csv"),row.names=FALSE,na="")

emit(
  "progress",100,"Completed",
  paste0("Analisis selesai. ",type1," vs ",type2," | Best RMSE: ",winner,
         " | Common GCP: ",common_n,"/",total_gcp),
  "success"
)
