#!/bin/bash

# Don't use set -e because we want to handle errors gracefully
# set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Mosaic Reveal Game Setup${NC}\n"

# Step 1: Deploy Contract
echo -e "${YELLOW}Step 1/5: Deploying contract...${NC}"
cd contract

# Deploy and capture output
DEPLOY_OUTPUT=$(sui client publish --json --gas-budget 100000000 2>&1)
DEPLOY_EXIT_CODE=$?

# Save output to file
mkdir -p tmp
echo "$DEPLOY_OUTPUT" > tmp/deploy.json

# Extract JSON from file (remove shell output patterns like @zsh (169-362))
DEPLOY_JSON_FILE="tmp/deploy.json"
if [ -f "$DEPLOY_JSON_FILE" ]; then
    # Remove shell output patterns and extract JSON
    # Remove lines that start with @shell patterns and remove inline patterns
    CLEANED_JSON=$(cat "$DEPLOY_JSON_FILE" | sed -E 's/@[a-zA-Z0-9_]+[[:space:]]*\([^)]+\)[[:space:]]*//g' | grep -vE '^@[a-zA-Z0-9_]+[[:space:]]*\(')
    
    # Try to find JSON object - extract from first { to last }
    FIRST_BRACE_LINE=$(echo "$CLEANED_JSON" | grep -n '{' | head -1 | cut -d: -f1)
    LAST_BRACE_LINE=$(echo "$CLEANED_JSON" | grep -n '}' | tail -1 | cut -d: -f1)
    
    if [ -n "$FIRST_BRACE_LINE" ] && [ -n "$LAST_BRACE_LINE" ] && [ "$FIRST_BRACE_LINE" -le "$LAST_BRACE_LINE" ]; then
        JSON_LINES=$(echo "$CLEANED_JSON" | sed -n "${FIRST_BRACE_LINE},${LAST_BRACE_LINE}p")
    else
        # Fallback: use all cleaned lines
        JSON_LINES="$CLEANED_JSON"
    fi
    
    # Save cleaned JSON to a temp file for jq parsing
    echo "$JSON_LINES" > tmp/deploy_cleaned.json
    
    # Display the output (pretty print JSON if possible)
    if command -v jq &> /dev/null && jq . tmp/deploy_cleaned.json >/dev/null 2>&1; then
        jq . tmp/deploy_cleaned.json
    else
        echo "$DEPLOY_OUTPUT"
    fi
else
    echo "$DEPLOY_OUTPUT"
fi

if [ $DEPLOY_EXIT_CODE -ne 0 ]; then
    echo -e "${RED}❌ Contract deployment failed!${NC}"
    echo "Exit code: $DEPLOY_EXIT_CODE"
    exit 1
fi

# Parse JSON output from file
if [ -f "tmp/deploy_cleaned.json" ] && command -v jq &> /dev/null; then
    # Extract Package ID from objectChanges where type is "published"
    PACKAGE_ID=$(jq -r '.objectChanges[]? | select(.type == "published") | .packageId' tmp/deploy_cleaned.json 2>/dev/null | head -1)
    
    # Extract OracleCap ID from objectChanges where objectType contains "OracleCap"
    ORACLE_CAP_ID=$(jq -r '.objectChanges[]? | select(.type == "created" and (.objectType | contains("OracleCap"))) | .objectId' tmp/deploy_cleaned.json 2>/dev/null | head -1)
elif [ -f "tmp/deploy.json" ] && command -v jq &> /dev/null; then
    # Fallback: try parsing the original file
    PACKAGE_ID=$(jq -r '.objectChanges[]? | select(.type == "published") | .packageId' tmp/deploy.json 2>/dev/null | head -1)
    ORACLE_CAP_ID=$(jq -r '.objectChanges[]? | select(.type == "created" and (.objectType | contains("OracleCap"))) | .objectId' tmp/deploy.json 2>/dev/null | head -1)
else
    # Fallback: use grep/sed for JSON parsing (less reliable)
    echo -e "${YELLOW}⚠️  jq not found, using fallback parsing (may be less reliable)${NC}"
    
    if [ -f "tmp/deploy_cleaned.json" ]; then
        DEPLOY_CONTENT=$(cat tmp/deploy_cleaned.json)
    elif [ -f "tmp/deploy.json" ]; then
        DEPLOY_CONTENT=$(cat tmp/deploy.json)
    else
        DEPLOY_CONTENT="$DEPLOY_OUTPUT"
    fi
    
    # Extract Package ID - look for "packageId" in published objectChanges
    PACKAGE_ID=$(echo "$DEPLOY_CONTENT" | grep -oE '"packageId"\s*:\s*"0x[0-9a-fA-F]{64}"' | head -1 | grep -oE '0x[0-9a-fA-F]{64}' || echo "")
    
    # Extract OracleCap ID - look for objectId in created objectChanges with OracleCap in objectType
    ORACLE_CAP_ID=$(echo "$DEPLOY_CONTENT" | grep -A 10 '"type"\s*:\s*"created"' | grep -B 5 -i 'OracleCap' | grep -oE '"objectId"\s*:\s*"0x[0-9a-fA-F]{64}"' | head -1 | grep -oE '0x[0-9a-fA-F]{64}' || echo "")
fi

if [ -z "$PACKAGE_ID" ]; then
    echo -e "${RED}❌ Failed to extract Package ID from deployment output${NC}"
    echo ""
    echo "Please manually extract the Package ID from the output above."
    echo "Look for a line containing 'packageId' or 'Published Objects:'"
    echo ""
    read -p "Enter Package ID (0x...): " PACKAGE_ID
    if [ -z "$PACKAGE_ID" ]; then
        echo -e "${RED}❌ Package ID is required. Exiting.${NC}"
        exit 1
    fi
fi

if [ -z "$ORACLE_CAP_ID" ]; then
    echo -e "${YELLOW}⚠️  Warning: Could not automatically extract OracleCap ID${NC}"
    echo ""
    echo "Please check the deployment output above for an object with type containing 'OracleCap'"
    echo "It should be in the 'Created Objects:' section"
    echo ""
    read -p "Enter OracleCap ID (0x...) or press Enter to skip: " ORACLE_CAP_ID
fi

echo ""
echo -e "${GREEN}✅ Package ID: $PACKAGE_ID${NC}"
if [ -n "$ORACLE_CAP_ID" ]; then
    echo -e "${GREEN}✅ OracleCap ID: $ORACLE_CAP_ID${NC}"
else
    echo -e "${YELLOW}⚠️  OracleCap ID not set - you'll need to set it manually later${NC}"
fi
echo ""

cd ..

# Step 2: Update .env.public files
echo -e "\n${YELLOW}Step 2/5: Updating .env.public files...${NC}"

# Update backend/.env.public
if [ -f "backend/.env.public" ]; then
    # Update PACKAGE_ID
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|PACKAGE_ID=.*|PACKAGE_ID=\"$PACKAGE_ID\"|" backend/.env.public
    else
        # Linux
        sed -i "s|PACKAGE_ID=.*|PACKAGE_ID=\"$PACKAGE_ID\"|" backend/.env.public
    fi
    
    # Update ORACLE_CAP_ID if found
    if [ -n "$ORACLE_CAP_ID" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|ORACLE_CAP_ID=.*|ORACLE_CAP_ID=\"$ORACLE_CAP_ID\"|" backend/.env.public
        else
            sed -i "s|ORACLE_CAP_ID=.*|ORACLE_CAP_ID=\"$ORACLE_CAP_ID\"|" backend/.env.public
        fi
    fi
    echo -e "${GREEN}✅ Updated backend/.env.public${NC}"
else
    echo -e "${RED}❌ backend/.env.public not found${NC}"
fi

# Update frontend/.env.public
if [ -f "frontend/.env.public" ]; then
    # Update VITE_TESTNET_PACKAGE_ID
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|VITE_TESTNET_PACKAGE_ID=.*|VITE_TESTNET_PACKAGE_ID=$PACKAGE_ID|" frontend/.env.public
    else
        sed -i "s|VITE_TESTNET_PACKAGE_ID=.*|VITE_TESTNET_PACKAGE_ID=$PACKAGE_ID|" frontend/.env.public
    fi
    echo -e "${GREEN}✅ Updated frontend/.env.public${NC}"
else
    echo -e "${RED}❌ frontend/.env.public not found${NC}"
fi

# Step 3: Setup Game
echo -e "\n${YELLOW}Step 3/5: Setting up game (this may take a while)...${NC}"
cd backend

# Check if .env exists, if not create from .env.public
if [ ! -f ".env" ] && [ -f ".env.public" ]; then
    cp .env.public .env
    echo -e "${GREEN}✅ Created .env from .env.public${NC}"
fi

# Check if ORACLE_PRIVATE_KEY is set in .env
if [ -f ".env" ]; then
    if ! grep -q "ORACLE_PRIVATE_KEY=" .env || grep -q "ORACLE_PRIVATE_KEY=$" .env || grep -q "^ORACLE_PRIVATE_KEY=\"\"" .env; then
        echo -e "${YELLOW}⚠️  Warning: ORACLE_PRIVATE_KEY not found in backend/.env${NC}"
        echo "The setup script requires ORACLE_PRIVATE_KEY to be set."
        echo "Please add it to backend/.env before continuing."
        echo ""
        read -p "Press Enter to continue anyway, or Ctrl+C to exit and set ORACLE_PRIVATE_KEY first..."
    fi
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing backend dependencies...${NC}"
    npm install
fi

# Run setup
echo -e "${BLUE}Running game setup (this may take several minutes)...${NC}"
if ! npm run setup; then
    echo -e "${RED}❌ Game setup failed!${NC}"
    echo "Please check the error messages above."
    exit 1
fi

cd ..

# Step 4: Extract Game ID and update .env.public files
echo -e "\n${YELLOW}Step 4/5: Extracting Game ID and updating .env.public files...${NC}"

# Find the most recent setup_summary.json in timestamped directories
# Try Linux find first (with -printf)
LATEST_SUMMARY=$(find backend/tmp -name "setup_summary.json" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

# Fallback for macOS (BSD find doesn't support -printf, use ls -t instead)
if [ -z "$LATEST_SUMMARY" ] || [ ! -f "$LATEST_SUMMARY" ]; then
    # Find all setup_summary.json files and sort by modification time
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: use ls -t to sort by modification time
        LATEST_SUMMARY=$(find backend/tmp -name "setup_summary.json" -type f -exec ls -t {} + 2>/dev/null | head -1)
    else
        # Linux: try stat if available
        LATEST_SUMMARY=$(find backend/tmp -name "setup_summary.json" -type f -exec stat -c "%Y %n" {} \; 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    fi
fi

# If still not found, try the old location
if [ -z "$LATEST_SUMMARY" ] || [ ! -f "$LATEST_SUMMARY" ]; then
    LATEST_SUMMARY="backend/tmp/setup_summary.json"
fi

# Check if setup_summary.json exists
if [ -f "$LATEST_SUMMARY" ]; then
    echo -e "${BLUE}Found setup summary: $LATEST_SUMMARY${NC}"
    # Extract gameId using jq if available, otherwise use grep/sed
    if command -v jq &> /dev/null; then
        GAME_ID=$(jq -r '.gameId' "$LATEST_SUMMARY")
    else
        # Use sed for cross-platform compatibility (works on both macOS and Linux)
        GAME_ID=$(grep '"gameId"' "$LATEST_SUMMARY" | sed -E 's/.*"gameId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | head -1)
    fi
    
    if [ -z "$GAME_ID" ] || [ "$GAME_ID" = "null" ]; then
        echo -e "${YELLOW}⚠️  Warning: Could not extract Game ID from setup_summary.json${NC}"
        echo "Please check $LATEST_SUMMARY and set GAME_ID manually"
    else
        echo -e "${GREEN}✅ Game ID: $GAME_ID${NC}"
        
        # Update frontend/.env.public
        if [ -f "frontend/.env.public" ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|VITE_TESTNET_GAME_ID=.*|VITE_TESTNET_GAME_ID=$GAME_ID|" frontend/.env.public
            else
                sed -i "s|VITE_TESTNET_GAME_ID=.*|VITE_TESTNET_GAME_ID=$GAME_ID|" frontend/.env.public
            fi
            echo -e "${GREEN}✅ Updated frontend/.env.public with Game ID${NC}"
        fi
    fi
else
    echo -e "${YELLOW}⚠️  Warning: setup_summary.json not found${NC}"
    echo "Game setup may have failed or the summary file was not created"
    echo "Please check the setup output above for the Game ID"
    echo "Looking in: backend/tmp/testnet-*/setup_summary.json"
fi

# Step 5: Start Frontend
echo -e "\n${YELLOW}Step 5/5: Starting frontend...${NC}"
cd frontend

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing frontend dependencies...${NC}"
    npm install
fi

echo -e "${GREEN}🚀 Starting frontend dev server...${NC}"
echo -e "${BLUE}Frontend will be available at http://localhost:5173${NC}\n"

npm run dev

