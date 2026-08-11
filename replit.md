# Treo Wuthering Waves

## Overview

This project runs a Discord rich presence for Wuthering Waves and exposes a
small HTTP health endpoint for Render/UptimeRobot monitoring.

## User preferences

- Keep the existing startup content and presence text unchanged unless a fix
  requires a minimal safety change.
- Never print or commit Discord tokens or other secrets.
- Discord gateway and Discord REST automation must run on Render only; do not
  start the bot from Replit because two gateways would compete for sessions.