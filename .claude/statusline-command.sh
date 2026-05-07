#!/bin/sh
# Claude Code status line: model · $cost today
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // .model.id // "Claude"')

# Compute today's estimated cost from cumulative session tokens.
# Pricing is approximate (per 1M tokens):
#   - claude-opus-4:          input $15 / output $75
#   - claude-sonnet-4-5/4-6:  input  $3 / output $15
#   - claude-3-5-sonnet:      input  $3 / output $15
#   - claude-haiku-3-5:       input $0.80 / output $4
#   - default fallback:        input  $3 / output $15
model_id=$(echo "$input" | jq -r '.model.id // ""')

# Pick per-million-token prices based on model id
case "$model_id" in
  *opus-4*|*opus4*)
    input_price="15"
    output_price="75"
    ;;
  *haiku*)
    input_price="0.8"
    output_price="4"
    ;;
  *)
    input_price="3"
    output_price="15"
    ;;
esac

total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')

# Calculate cost only if we have token data
if [ "$total_input" -gt 0 ] 2>/dev/null || [ "$total_output" -gt 0 ] 2>/dev/null; then
  cost=$(awk -v i="$total_input" -v o="$total_output" \
             -v ip="$input_price" -v op="$output_price" \
         'BEGIN { printf "%.4f", (i * ip / 1000000) + (o * op / 1000000) }')
  printf "%s · \$%s today" "$model" "$cost"
else
  printf "%s" "$model"
fi
