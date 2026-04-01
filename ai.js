class AIService {
    constructor() {
        this.provider = "Default-Brain";
    }

    async generateText(systemPrompt, userPrompt) {
        try {
            const response = await fetch('/ai/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system: systemPrompt,
                    prompt: userPrompt
                })
            });
            return await response.json();
        } catch (e) {
            console.error("AI Service Error:", e);
            throw e;
        }
    }
}

window.AIService = new AIService();

/**
 * executeStrategy - Main AI Reasoning Loop
 * Called when entry window is reached in AI mode.
 */
async function executeStrategy() {
    if (!state.aiEnabled || state.currentBet.active || !state.activeMarket) return;

    logThought("ðŸ§  CONSULTING: Brain Cluster...", "info");

    try {
        // Construct detailed market context for the LLM
        const context = `
            Market: ${state.activeMarket.symbol}
            Time: ${new Date().toLocaleTimeString()}
            Current Price: $${state.livePrice}
            Balance: $${state.balance.toFixed(2)}
        `;

        const response = await window.AIService.generateText(state.aiSystemPrompt, context);

        const match = response.text.match(/\{.*\}/s);
        if (match) {
            const decision = JSON.parse(match[0]);
            logThought(`ðŸ’¡ AI DECISION: ${decision.side} (${decision.confidence}%) - ${decision.reasoning}`, decision.confidence > 70 ? 'success' : 'info');

            if (decision.action === 'BUY' && decision.confidence >= 60) {
                executeManualEntry(decision.side);
            }
        }
    } catch (e) {
        logThought("â Œ AI consultation failed.", "error");
        console.error(e);
    }
}

window.executeStrategy = executeStrategy;
