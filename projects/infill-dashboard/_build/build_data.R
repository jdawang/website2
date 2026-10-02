# Build the static data files for the infill map page (../index.qmd).
#
# Run manually each quarter, from this directory:
#   cd projects/infill-dashboard/_build && Rscript build_data.R
#
# Reads the gitignored shared data/ dir and the permit cache, and writes small
# committed JSON files one level up. The page itself has no R, so CI never runs
# this. It asserts aggressively: a bad file is worse than a failed build.

suppressMessages({
  library(tidyverse)
  library(sf)
  library(jsonlite)
  library(jdawangHelpers)
})

# ---- config ------------------------------------------------------------------
AS_OF <- as.Date("2026-09-30")
START_YEAR <- 2024
N_MONTHS <- (year(AS_OF) - START_YEAR) * 12 + month(AS_OF) # 33
TYPES <- c("Backyard House", "Duplex to Fourplex", "Fiveplex to Eightplex")
DATA <- "../../../data"
OUT <- ".."
PROPERTY_DIR <- file.path(DATA, "Property Information (Current Calendar Year)_20260113")
METRIC <- 3776 # NAD83(CSRS) / UTM zone 12N, for buffers and simplification in metres
EDMONTON_BBOX <- c(xmin = -113.72, xmax = -113.28, ymin = 53.33, ymax = 53.72)

norm_name <- function(x) str_squish(str_to_upper(x))

# Title case that keeps the bits str_to_title mangles: McKernan, O'Day, and
# addresses like "10339G - 149 Street NW".
pretty_name <- function(x) {
  x |>
    str_to_title() |>
    str_replace_all("\\bMc[a-z]", \(m) paste0("Mc", str_to_upper(str_sub(m, -1)))) |>
    str_replace_all("\\bO'([a-z])", \(m) paste0("O'", str_to_upper(str_sub(m, -1))))
}
pretty_address <- function(x) {
  x |>
    str_to_title() |>
    str_replace_all("\\b(Nw|Ne|Sw|Se)\\b", str_to_upper) |>
    str_replace_all("(?<=[0-9])[a-z]\\b", str_to_upper)
}

crosswalk <- read_csv("crosswalk.csv", show_col_types = FALSE)
fix_name <- function(x) {
  x <- norm_name(x)
  coalesce(crosswalk$to[match(x, crosswalk$from)], x)
}

# ---- 1. permits --------------------------------------------------------------
bp_raw <- get_edmonton_building_permit_data(
  cache_dir = Sys.getenv("EDMONTON_BP_CACHE_PATH"),
  end_date = format(AS_OF),
  force_refresh = FALSE
)

is_rs <- function(zoning) {
  map_lgl(
    str_split(zoning, ",\\s*"),
    \(z) length(z) > 0 && all(str_squish(z) == "RS")
  )
}

permits <- bp_raw |>
  filter(date_issued >= as.Date(paste0(START_YEAR, "-01-01")), date_issued <= AS_OF) |>
  filter_edmonton_residential() |>
  filter(units_added >= 1, work_type != "(04) Excavation") |>
  add_edmonton_project_type() |>
  add_edmonton_suite_info() |>
  add_edmonton_neighbourhood_type() |>
  filter(is_rs(zoning), project_type %in% TYPES) |>
  mutate(
    neighbourhood = fix_name(neighbourhood),
    t = as.integer(factor(project_type, levels = TYPES)) - 1L,
    m = as.integer((year - START_YEAR) * 12 + month_number - 1),
    has_geom = !st_is_empty(geometry),
    # Occupancy granted = the building is complete. YYYYMM of the date, 0 if none recorded.
    occ_ym = if_else(is.na(occupancy_granted_date), 0L, as.integer(year(occupancy_granted_date) * 100 + month(occupancy_granted_date))),
    occ = occ_ym > 0L
  )
message("permits in scope: ", nrow(permits), "; units: ", sum(permits$units_added))
stopifnot(!anyNA(permits$neighbourhood), all(permits$m %in% 0:(N_MONTHS - 1)))

# ---- 2. property roll: RS lots, year built, and coordinates for pass B --------
lyr <- st_layers(PROPERTY_DIR)$name[1]
roll <- read_sf(
  PROPERTY_DIR,
  query = sprintf(
    "SELECT house_numb, street_nam, zoning, neighbou_2, year_built, latitude, longitude FROM \"%s\" WHERE zoning = 'RS'",
    lyr
  )
) |>
  st_drop_geometry() |>
  filter(!is.na(house_numb)) |>
  mutate(
    house = norm_name(house_numb),
    street = norm_name(street_nam),
    neighbourhood = fix_name(neighbou_2)
  ) |>
  distinct(house, street, .keep_all = TRUE)

rs_by_nbhd <- roll |>
  group_by(neighbourhood) |>
  summarize(rs = n(), yb = median(year_built, na.rm = TRUE), .groups = "drop")

# Pass A: the permit's own geometry. Pass B: match the address to the roll.
parse_address <- function(address) {
  a <- norm_name(address)
  a <- str_remove(a, "^[0-9A-Z]+,\\s*") # leading unit number, e.g. "36, 6905 - 25 AVENUE SW"
  tibble(
    house = str_squish(str_extract(a, "^[^-]+")),
    street = str_squish(str_remove(a, "^[^-]+-"))
  )
}
roll_xy <- roll |>
  group_by(house, street) |>
  summarize(lon_b = mean(longitude), lat_b = mean(latitude), .groups = "drop")

permit_xy <- st_coordinates(permits[permits$has_geom, ]) |>
  as_tibble() |>
  set_names(c("lon_a", "lat_a")) |>
  mutate(row = which(permits$has_geom))

pts <- permits |>
  st_drop_geometry() |>
  mutate(row = row_number()) |>
  bind_cols(parse_address(permits$address)) |>
  left_join(permit_xy, by = "row") |>
  left_join(roll_xy, by = c("house", "street")) |>
  mutate(
    q = case_when(!is.na(lon_a) ~ 0L, !is.na(lon_b) ~ 1L, .default = NA_integer_),
    lon = coalesce(lon_a, lon_b),
    lat = coalesce(lat_a, lat_b)
  )
message(
  "geocoded: permit geometry ", sum(pts$q == 0, na.rm = TRUE),
  ", address match ", sum(pts$q == 1, na.rm = TRUE),
  ", unmapped ", sum(is.na(pts$q))
)

# ---- 3. neighbourhoods -------------------------------------------------------
nb <- read_sf(file.path(DATA, "City_of_Edmonton_-_Neighbourhoods_20260417.geojson")) |>
  st_transform(4326) |>
  transmute(
    id = as.integer(neighbourhood_number),
    key = norm_name(name),
    nm = pretty_name(name),
    wd = civic_ward_name,
    di = district
  )
stopifnot(!anyDuplicated(nb$key))

unmatched <- setdiff(unique(pts$neighbourhood), nb$key)
stopifnot("permit neighbourhoods missing from polygons" = length(unmatched) == 0)
pts <- left_join(pts, st_drop_geometry(nb) |> select(key, id), by = c("neighbourhood" = "key"))

# Population. 2021 file is three stacked copies of one table (header repeated).
read_pop <- function(path, name_col, value_col) {
  read_csv(path, show_col_types = FALSE) |>
    select(name = all_of(name_col), n = all_of(value_col)) |>
    filter(name != name_col, !is.na(name)) |>
    mutate(name = fix_name(name), n = parse_number(as.character(n))) |>
    distinct(name, .keep_all = TRUE)
}
pop21 <- read_pop(file.path(DATA, "population_2021.csv"), "NEIGHBOURHOOD", "2021") |> rename(p21 = n)
pop71 <- read_pop(file.path(DATA, "population_1971.csv"), "Neighbourhood", "Total - Age") |> rename(p71 = n)
for (p in list(pop21, pop71)) {
  miss <- setdiff(p$name, nb$key)
  if (length(miss)) message("population names with no polygon (ignored): ", paste(miss, collapse = ", "))
}

# Neighbourhood type: from permits where known, else from the centroid.
type_lookup <- permits |>
  st_drop_geometry() |>
  distinct(neighbourhood, neighbourhood_type) |>
  filter(!is.na(neighbourhood_type))
totals <- pts |>
  group_by(id) |>
  summarize(pt = n(), ut = sum(units_added), .groups = "drop")

neighbourhoods <- nb |>
  inner_join(rs_by_nbhd, by = c("key" = "neighbourhood")) |>
  left_join(pop21, by = c("key" = "name")) |>
  left_join(pop71, by = c("key" = "name")) |>
  left_join(totals, by = "id") |>
  left_join(type_lookup, by = c("key" = "neighbourhood")) |>
  mutate(
    pt = replace_na(pt, 0L),
    ut = replace_na(ut, 0),
    pc = round(pt / rs, 5),
    pg = if_else(!is.na(p71) & p71 > 0 & !is.na(p21) & p21 > 0, round(p21 / p71 - 1, 4), NA_real_),
    ty = as.character(neighbourhood_type),
    yb = as.integer(yb)
  ) |>
  select(id, nm, wd, di, ty, rs, yb, p21, p71, pg, pt, ut, pc)
stopifnot(all(unique(pts$id) %in% neighbourhoods$id))

# Untyped neighbourhoods (no in-scope permits): classify by centroid.
untyped <- is.na(neighbourhoods$ty)
if (any(untyped)) {
  cen <- st_centroid(st_geometry(neighbourhoods[untyped, ]))
  in_mature <- lengths(st_intersects(cen, st_transform(mature_neighbourhood, 4326))) > 0
  in_henday <- lengths(st_intersects(cen, st_transform(henday, 4326))) > 0
  neighbourhoods$ty[untyped] <- case_when(
    in_mature ~ "Mature",
    in_henday ~ "Between mature and Henday",
    .default = "Outside Henday"
  )
}

# Simplify with shared-topology preservation; keep only what the map needs.
neighbourhoods <- tryCatch(
  rmapshaper::ms_simplify(neighbourhoods, keep = 0.12, keep_shapes = TRUE, snap = TRUE),
  error = function(e) {
    message("rmapshaper failed (", conditionMessage(e), "); falling back to st_simplify")
    neighbourhoods |>
      st_transform(3776) |>
      st_simplify(preserveTopology = TRUE, dTolerance = 10) |>
      st_transform(4326)
  }
)

# ---- 4. LRT stops ------------------------------------------------------------
future_stops <- read_sf(file.path(DATA, "future_lrt_stops.geojson")) |>
  filter(!(stop_name %in% c("Castle Downs Station", "145 Ave Station", "137 Ave Station", "132 Ave Station")))
lrt <- load_edmonton_transit_stops(
  gtfs_path = file.path(DATA, "ca-alberta-edmonton-transit-system-gtfs-714.zip"),
  service_date = as.Date("2023-11-09"),
  future_stops = future_stops,
  crs = 4326
) |>
  transmute(name = stop_name_short, status)
lrt_m <- st_transform(lrt, METRIC)

# Existing lines: the City's GTFS shapes for the Capital, Metro and Valley lines.
gtfs <- tidytransit::read_gtfs(
  file.path(DATA, "ca-alberta-edmonton-transit-system-gtfs-714.zip"),
  files = c("routes", "trips", "shapes")
)
lrt_route_ids <- c(Capital = "021R", Metro = "022R", Valley = "023R")
shape_routes <- gtfs$trips |>
  filter(route_id %in% lrt_route_ids) |>
  distinct(route_id, shape_id)
shapes_m <- tidytransit::shapes_as_sf(gtfs$shapes) |>
  inner_join(shape_routes, by = "shape_id") |>
  st_transform(METRIC)
route_line <- function(id) shapes_m |> filter(route_id == id) |> st_union() |> st_line_merge()
capital <- route_line(lrt_route_ids[["Capital"]])
valley <- route_line(lrt_route_ids[["Valley"]])
# Metro shares about 5 km of track with Capital as near-coincident shapes that
# would draw as doubled lines, so keep only the part Capital doesn't cover.
metro <- route_line(lrt_route_ids[["Metro"]]) |> st_difference(st_buffer(capital, 20))
existing_lines <- st_sf(
  kind = "existing",
  line = c("Capital", "Valley", "Metro"),
  geometry = c(capital, valley, metro)
)

# Under construction: OpenStreetMap alignments, cached because the public Overpass
# server is often too busy. Set REFRESH_OSM=1 to refetch.
osm_cache <- file.path(DATA, "osm_future_lrt.json")
fetch_osm <- function() {
  query <- '[out:json][timeout:90];way["railway"="construction"]["construction"="light_rail"](53.36,-113.75,53.66,-113.35);out geom;'
  for (attempt in 1:4) {
    txt <- tryCatch(
      httr2::request("https://overpass-api.de/api/interpreter") |>
        httr2::req_user_agent("jacobdawang.com infill-map build script") |>
        httr2::req_body_form(data = query) |>
        httr2::req_timeout(120) |>
        httr2::req_perform() |>
        httr2::resp_body_string(),
      error = \(e) ""
    )
    # Overpass reports "server too busy" as a 200 with a non-JSON body.
    if (nzchar(txt) && jsonlite::validate(txt)) return(txt)
    message("Overpass attempt ", attempt, " failed; retrying")
    Sys.sleep(20 * attempt)
  }
  stop("Overpass never returned valid JSON. Try again later, or place a saved response at ", osm_cache)
}
if (!file.exists(osm_cache) || Sys.getenv("REFRESH_OSM") == "1") writeLines(fetch_osm(), osm_cache)
osm_ways <- fromJSON(osm_cache, simplifyVector = FALSE)$elements
stopifnot("no OSM ways in cache" = length(osm_ways) > 0)
osm_m <- st_sf(
  osm_name = map_chr(osm_ways, \(w) w$tags$name %||% NA_character_),
  geometry = st_sfc(
    map(osm_ways, \(w) st_linestring(do.call(rbind, map(w$geometry, \(p) c(p$lon, p$lat))))),
    crs = 4326
  )
) |>
  st_transform(METRIC)
# Keep alignments near a stop; drops unrelated construction elsewhere in the bbox.
osm_m <- osm_m[lengths(st_is_within_distance(osm_m, lrt_m, 1500)) > 0, ]

# Which line is each way on? OSM names most of them; a few are unnamed, so those
# take the line of the nearest named way.
osm_m$line <- case_when(
  str_detect(osm_m$osm_name, "Valley") ~ "Valley",
  str_detect(osm_m$osm_name, "Capital") ~ "Capital",
  str_detect(osm_m$osm_name, "Metro") ~ "Metro"
)
named <- !is.na(osm_m$line)
stopifnot("no OSM ways could be assigned to a line by name" = any(named))
osm_m$line[!named] <- osm_m$line[named][st_nearest_feature(osm_m[!named, ], osm_m[named, ])]
print(osm_m |> st_drop_geometry() |> count(line, osm_name))

# Official colours: the GTFS route_color, as in the blog posts. Existing and
# under-construction segments of a line share a colour.
line_colours <- gtfs$routes |>
  filter(route_id %in% lrt_route_ids) |>
  transmute(line = names(lrt_route_ids)[match(route_id, lrt_route_ids)], colour = paste0("#", str_remove(route_color, "^#")))
stopifnot("expected a colour for each of the three lines" = nrow(line_colours) == 3, !anyNA(line_colours$colour))

construction_lines <- osm_m |>
  group_by(line) |>
  summarise(do_union = TRUE, .groups = "drop") |>
  mutate(geometry = st_line_merge(geometry), kind = "construction") |>
  left_join(line_colours, by = "line")
existing_lines <- left_join(existing_lines, line_colours, by = "line")
construction <- st_union(construction_lines)

# Every future stop should sit on a mapped alignment. Print the evidence, then
# fail loudly if the three line ends are not covered.
future_m <- filter(lrt_m, status == "future")
future_gap <- tibble(stop = future_m$name, metres_to_line = round(as.numeric(st_distance(future_m, construction)[, 1])))
print(future_gap, n = Inf)
line_ends <- c("Lewis Farms", "Heritage Valley North", "Blatchford Gate")
stopifnot(
  "line end not covered by an OSM alignment (see table above)" =
    all(future_gap$metres_to_line[future_gap$stop %in% line_ends] <= 200),
  "Valley West alignment does not reach the existing 102 Street stop" =
    as.numeric(st_distance(filter(lrt_m, name == "102 Street"), construction)) <= 500
)

lrt_lines <- bind_rows(existing_lines, construction_lines) |>
  select(kind, line, colour) |>
  st_simplify(dTolerance = 8) |>
  st_transform(4326)

# Radii: unioned 400 m and 800 m buffers around every stop, existing and future.
lrt_buffers <- st_sf(
  r = c(800L, 400L),
  geometry = c(
    st_union(st_buffer(lrt_m, 800)),
    st_union(st_buffer(lrt_m, 400))
  )
) |>
  st_simplify(dTolerance = 3) |>
  st_transform(4326)
stopifnot(
  "invalid LRT geometry" = all(st_is_valid(lrt_lines)) && all(st_is_valid(lrt_buffers)),
  "expected 3 existing + 3 under-construction line features" = nrow(lrt_lines) == 6,
  "every line feature needs a colour" = !anyNA(lrt_lines$colour)
)

# ---- 4b. frequent bus network --------------------------------------------------
# Same stops as the Q3 building permits post: routes 1-9 with scheduled 15-minute
# headways, 6 am to 9 pm, on the 2023-11-09 service day.
fbus <- get_edmonton_frequent_bus_stops(
  gtfs_path = file.path(DATA, "ca-alberta-edmonton-transit-system-gtfs-714.zip"),
  service_date = as.Date("2023-11-09"),
  crs = METRIC
)
fbus_route_ids <- gtfs$routes |>
  filter(route_short_name %in% sprintf("%03d", 1:9)) |>
  pull(route_id)
fbus_shapes <- tidytransit::shapes_as_sf(gtfs$shapes) |>
  inner_join(distinct(filter(gtfs$trips, route_id %in% fbus_route_ids), shape_id), by = "shape_id") |>
  st_transform(METRIC)
# Route 1 branches (1A/1B) run every ~30 minutes and have no frequent stops of their
# own, so keep only the part of each route within 250 m of a frequent stop.
fbus_line <- fbus_shapes |>
  st_union() |>
  st_line_merge() |>
  st_intersection(st_union(st_buffer(fbus, 250))) |>
  st_sf(geometry = _) |>
  st_simplify(dTolerance = 8) |>
  st_transform(4326)
fbus_buffer <- st_sf(r = 400L, geometry = st_union(st_buffer(fbus, 400))) |>
  st_simplify(dTolerance = 3) |>
  st_transform(4326)
fbus_pts <- fbus |> transmute(name = stop_name) |> st_transform(4326)
stopifnot(
  "unexpected frequent stop count" = between(nrow(fbus), 100, 2000),
  "invalid frequent bus geometry" = all(st_is_valid(fbus_line)) && all(st_is_valid(fbus_buffer)),
  "empty frequent bus line" = !st_is_empty(fbus_line)[1],
  "frequent stops far from the mapped line" =
    all(as.numeric(st_distance(fbus, st_transform(fbus_line, METRIC))[, 1]) <= 250),
  "buffer misses a stop" = all(lengths(st_intersects(fbus_pts, fbus_buffer)) > 0)
)
message("frequent bus stops: ", nrow(fbus))

# ---- 5. output arrays --------------------------------------------------------
mapped <- pts |> filter(!is.na(q))
x0 <- floor(min(mapped$lon) * 100) / 100
y0 <- floor(min(mapped$lat) * 100) / 100
S <- 1e5

permits_json <- list(
  meta = list(
    built = format(Sys.Date()),
    as_of = format(AS_OF),
    property_snapshot = "2026-01-13",
    types = TYPES,
    n_months = N_MONTHS,
    n_total = nrow(pts),
    n_mapped = nrow(mapped),
    units_total = sum(pts$units_added),
    n_occ = sum(pts$occ),
    occ_median_lag_days = as.integer(median(as.numeric(pts$occupancy_granted_date - pts$date_issued)[pts$occ])),
    occ_before_issue = sum(pts$occupancy_granted_date < pts$date_issued, na.rm = TRUE),
    geo_src_counts = list(permit = sum(mapped$q == 0), address = sum(mapped$q == 1))
  ),
  x0 = x0, y0 = y0, s = S,
  t = mapped$t, m = mapped$m, u = as.integer(mapped$units_added), o = mapped$occ_ym,
  i = mapped$id, q = mapped$q,
  x = as.integer(round((mapped$lon - x0) * S)),
  y = as.integer(round((mapped$lat - y0) * S)),
  a = pretty_address(mapped$address)
)

facts <- pts |>
  group_by(id, t, m) |>
  summarize(
    p = n(), u = as.integer(sum(units_added)), pm = sum(!is.na(q)),
    # the same three counts restricted to permits with occupancy granted
    po = sum(occ), uo = as.integer(sum(units_added[occ])), pmo = sum(occ & !is.na(q)),
    .groups = "drop"
  ) |>
  arrange(id, t, m)
facts_json <- lapply(as.list(facts), as.integer)

# ---- 6. QA -------------------------------------------------------------------
stopifnot(
  "facts permits != permits" = sum(facts$p) == nrow(pts),
  "facts units != units" = sum(facts$u) == sum(pts$units_added),
  "facts mapped != mapped" = sum(facts$pm) == nrow(mapped),
  "facts occupancy != occupancy" = sum(facts$po) == sum(pts$occ) && sum(facts$uo) == sum(pts$units_added[pts$occ]) && sum(facts$pmo) == sum(mapped$occ),
  "coords outside Edmonton" = all(
    between(mapped$lon, EDMONTON_BBOX[["xmin"]], EDMONTON_BBOX[["xmax"]]),
    between(mapped$lat, EDMONTON_BBOX[["ymin"]], EDMONTON_BBOX[["ymax"]])
  ),
  "arrays not aligned" = length(unique(lengths(permits_json[c("t", "m", "u", "o", "i", "q", "x", "y", "a")]))) == 1,
  "ids not integer" = is.integer(neighbourhoods$id)
)

# ---- 7. write ----------------------------------------------------------------
write_json(permits_json, file.path(OUT, "permits.json"), auto_unbox = TRUE, digits = NA)
write_json(facts_json, file.path(OUT, "neighbourhood-facts.json"), auto_unbox = TRUE)

write_geo <- function(x, path, ...) {
  unlink(path)
  st_write(x, path, driver = "GeoJSON", quiet = TRUE, layer_options = c("COORDINATE_PRECISION=5", "RFC7946=YES"), ...)
}
write_geo(neighbourhoods, file.path(OUT, "neighbourhoods.geojson"))
write_geo(lrt, file.path(OUT, "lrt.geojson"))
write_geo(lrt_lines, file.path(OUT, "lrt-lines.geojson"))
write_geo(lrt_buffers, file.path(OUT, "lrt-buffers.geojson"))
write_geo(fbus_pts, file.path(OUT, "fbus-stops.geojson"))
write_geo(fbus_line, file.path(OUT, "fbus-lines.geojson"))
write_geo(fbus_buffer, file.path(OUT, "fbus-buffers.geojson"))

sizes <- map_dfr(
  c("permits.json", "neighbourhood-facts.json", "neighbourhoods.geojson", "lrt.geojson", "lrt-lines.geojson", "lrt-buffers.geojson", "fbus-stops.geojson", "fbus-lines.geojson", "fbus-buffers.geojson"),
  \(f) {
    p <- file.path(OUT, f)
    tibble(file = f, kb = round(file.size(p) / 1024, 1), gz_kb = round(length(memCompress(readBin(p, "raw", file.size(p)), "gzip")) / 1024, 1))
  }
)
print(sizes)
message("OK: ", nrow(pts), " permits (", nrow(mapped), " mapped), ", nrow(neighbourhoods), " neighbourhoods")
