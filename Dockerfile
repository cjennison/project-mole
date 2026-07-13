FROM node:24-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    git \
    ca-certificates \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install Copilot CLI
RUN npm install -g @github/copilot

# Install Playwright MCP and Playwright browser management
RUN npm install -g @playwright/mcp@latest playwright

# Install Playwright system dependencies and Chromium browser
RUN npx playwright install-deps chromium && \
    npx playwright install chromium

# Set working directory (workspace is mounted at runtime)
WORKDIR /workspace

# Default MCP config (used if ~/.copilot is not mounted from host)
COPY config/mcp.json /etc/copilot/mcp.json

# Entrypoint
COPY scripts/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Copilot home
ENV COPILOT_HOME=/root/.copilot

ENTRYPOINT ["/entrypoint.sh"]
