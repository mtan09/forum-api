#!/bin/bash
# Installs the 3 CLIs needed for setup

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'
BOLD='\033[1m'

echo ""
echo "${BOLD}Installing CLIs...${RESET}"
echo ""

install_if_missing() {
  local cmd=$1
  local pkg=$2
  if command -v "$cmd" &>/dev/null; then
    echo "${GREEN}✓${RESET} $cmd already installed ($(command -v $cmd))"
  else
    echo "${CYAN}→${RESET} Installing $pkg..."
    npm install -g "$pkg"
    echo "${GREEN}✓${RESET} $cmd installed"
  fi
}

install_if_missing neonctl neonctl
install_if_missing wrangler wrangler
install_if_missing railway @railway/cli

echo ""
echo "${BOLD}All CLIs installed.${RESET}"
echo ""
echo "Next — authenticate each service (opens browser once per service):"
echo ""
echo "  1.  ${CYAN}neonctl auth${RESET}"
echo "  2.  ${CYAN}wrangler login${RESET}"
echo "  3.  ${CYAN}railway login${RESET}"
echo ""
echo "Then run:  ${CYAN}npm run setup${RESET}"
echo ""
