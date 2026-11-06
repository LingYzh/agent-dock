function values(option) {
    return (option.options || []).flatMap((item) => item.options || [item]).map((item) => item.value);
}

export async function configureSession(agent, requested) {
    // Apply model first: its response can change the available reasoning-level catalog.
    for (const [argument, category, fallbackIds] of [
        ['model', 'model', ['model']],
        ['thoughtLevel', 'thought_level', ['thought_level', 'effort']],
        ['permissionMode', 'mode', ['mode']]
    ]) {
        const value = requested[argument];
        if (value === undefined) continue;
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${argument} must be a nonempty string`);
        const option = agent.configOptions?.find((item) => item.category === category) || agent.configOptions?.find((item) => fallbackIds.includes(item.id));
        if (!option || option.type !== 'select') throw new Error(`Agent does not expose ${argument}`);
        if (argument !== 'model' && !values(option).includes(value)) throw new Error(`Unsupported ${argument}: ${value}; available: ${values(option).join(', ')}`);
        if (argument === 'permissionMode' && !['default', 'plan'].includes(value)) throw new Error('Only default or plan permission mode can be requested by this bridge');
        const changed = await agent.client.request('session/set_config_option', { sessionId: agent.sessionId, configId: option.id, value });
        agent.configOptions = changed.configOptions;
        if (agent.configOptions?.find((item) => item.id === option.id)?.currentValue !== value) throw new Error(`Agent did not confirm requested ${argument}: ${value}`);
    }
}
