FROM  ghcr.io/rocker-org/geospatial:4.6.0

RUN  sudo apt-get update \
  && sudo apt install -y curl \
  && sudo curl -sLO  https://cdn.posit.co/positron/releases/deb/x86_64/Positron-2026.05.2-3-x64.deb \
  && sudo curl -L https://rig.r-pkg.org/deb/rig.gpg -o /etc/apt/trusted.gpg.d/rig.gpg \
  && sudo sh -c 'echo "deb http://rig.r-pkg.org/deb rig main" > /etc/apt/sources.list.d/rig.list' \
  && sudo apt-get update \
  && sudo apt install -y ./Positron-2026.05.2-3-x64.deb \
  && sudo apt install -y \
  bat \
  fonts-firacode \
  r-rig \
  zsh \
  cargo \
  rustc \
  gnome-keyring \
  && sudo curl -sS https://starship.rs/install.sh | sh -s -- -y \
  && chsh -s $(which zsh) \
  && rig add 4.6.0 \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
