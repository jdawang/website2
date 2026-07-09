# Standalone exploration script: map all Edmonton bike lane network segments
# coloured by classification. Not sourced by index.qmd -- run manually with
# `Rscript explore_bike_lanes.R` from this directory.

library(tidyverse)
library(sf)
library(mountainmathHelpers)
library(jdawangHelpers)

options(nextzen_API_key = Sys.getenv("NEXTZEN_API_KEY"))

bike_lanes <- get_edmonton_bike_lane_data(
  cache_dir = Sys.getenv("EDMONTON_BP_CACHE_PATH")
)

crs <- lambert_conformal_conic_at(bike_lanes)
bike_lanes <- st_transform(bike_lanes, crs)

p <- ggplot(bike_lanes) +
  layers_map_base(mode = "light", roads_type = "all") +
  geom_sf(aes(colour = classification), linewidth = 0.5) +
  theme_map(mode = "light") +
  theme_jd(mode = "light") +
  labs(
    title = "Edmonton bike lane network by classification",
    colour = "Classification",
    caption = CAPTION_COE
  )

ggsave("bike_lanes_by_classification.png", p, width = 10, height = 10, dpi = 150)