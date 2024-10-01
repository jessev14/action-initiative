const moduleID = 'action-initiative';

const lg = x => console.log(x);

let timerInterval;
let socket;


Hooks.once('init', () => {
    libWrapper.register(moduleID, 'CONFIG.Combat.documentClass.prototype._sortCombatants', newSortCombatants, 'OVERRIDE');
    libWrapper.register(moduleID, 'CONFIG.Token.objectClass.prototype._drawEffects', drawTargets, 'WRAPPER');

    game.settings.register(moduleID, 'timerDuration', {
        name: "Timer Duration",
        hint: "Time in seconds.",
        type: new foundry.data.fields.NumberField({ step: 1 }),
        scope: 'world',
        config: true,
        default: 60,
        requiresReload: true,
        onChange: () => {
            game.settings.set(moduleID, 'timerCurrentTime', 0);
        }
    });

    game.settings.register(moduleID, 'timerStartTime', {
        scope: 'world',
        type: Number,
        default: 0
    });

    game.settings.register(moduleID, 'timerCurrentTime', {
        scope: 'world',
        type: new foundry.data.fields.NumberField({ min: 0 }),
        default: 0
    });
});

Hooks.once('socketlib.ready', () => {
    socket = socketlib.registerModule(moduleID);
    socket.register('startTimer', startTimer);
});

Hooks.once('ready', () => {
    if (game.settings.get(moduleID, 'timerStartTime')) startTimer();
});


Hooks.on('renderCombatTracker', (app, [html], appData) => {
    const timerDiv = document.createElement('div');
    timerDiv.classList.add(`${moduleID}-timer`);
    timerDiv.style.display = 'flex';
    timerDiv.style['flex-direction'] = 'row';
    // add play button for GMs.
    const currentTime = game.settings.get(moduleID, 'timerCurrentTime');
    if (currentTime) timerDiv.innerHTML = 'Time: ' + `${currentTime}`.padStart(2, '0');
    else timerDiv.innerText = 'Time: --';
    if (game.user.isGM && !currentTime) {
        timerDiv.querySelector('a').addEventListener('click', async () => {
            if (game.paused) return ui.notifications.warn('Cannot start timer while game is paused.');

            await game.settings.set(moduleID, 'timerStartTime', Date.now());
            await game.settings.set(moduleID, 'timerCurrentTime', 0);
            await new Promise(resolve => setTimeout(resolve, 500));
            return socket.executeForEveryone('startTimer');
        });
    }
    const header = html.querySelector('header.combat-tracker-header');
    header.prepend(timerDiv);

    const combatantOl = html.querySelector('ol#combat-tracker');
    for (const combatantLi of combatantOl.querySelectorAll('li.combatant')) {
        const combatantID = combatantLi.dataset.combatantId;
        const combatant = game.combat.combatants.get(combatantID);
        const initiative = combatant.initiative;

        const initiativeGroup = (initiative >= 3 || initiative === null) ? 'called' : initiative > 2 ? 'ranged' : 'melee';
        const backgroundColorMap = {
            called: 'rgba(74, 200, 31, 0.5)',
            ranged: 'rgba(31, 67, 200, 0.5)',
            melee: 'rgba(200, 31, 31, 0.5)'
        };
        const initiativeDiv = combatantLi.querySelector('div.token-initiative');
        initiativeDiv.style.background = backgroundColorMap[initiativeGroup];
        if (initiative) {
            const initiativeSpan = initiativeDiv.querySelector('span.initiative');
            const newText = initiativeSpan.innerText.slice(2);
            initiativeSpan.innerText = newText;
        }
    }
});

// Hooks.on('combatStart', (combat, updateData) => onRoundStart(combat));

Hooks.on('combatRound', (combat, updateData, updateOptions) => onRoundStart(combat));

Hooks.on('dnd5e.useItem', async (item, config, options) => {
    const { actor } = item;
    if (!actor.inCombat) return;
    if (item.hasAttack) return;

    if (item.hasDamage || item.type === 'spell') {
        const spellAbl = actor.system.attributes.spellcasting;
        const spellMod = actor.system.abilities[spellAbl]?.mod;
        if (spellMod) {
            const token = actor.getActiveTokens(false, true)[0];
            const combatant = token?.combatant;
            if (combatant) {
                const roll = new game.system.dice.D20Roll('d20 + @spellMod', { spellMod });
                const chatData = {
                    user: game.user.id,
                    speaker: ChatMessage.getSpeaker({ actor }),
                    flavor: `${token.name} rolls for Initiatve!`
                };
                await roll.toMessage(chatData);
                let initiativeString = ``;
                if (item.isHealing || !item.hasDamage) initiativeString += '3.';
                else if (item.system.range.units === 'touch') initiativeString += '1.';
                else initiativeString += '2.';
                initiativeString += `${roll.total}`.padStart(2, '0');
                if (game.settings.get('dnd5e', 'initiativeDexTiebreaker')) initiativeString += `${actor.system.abilities.dex.value}`.padStart(2, '0');

                return combatant.update({ initiative: Number(initiativeString) });
            }
        }
    }
});

Hooks.on('dnd5e.rollAttack', (item, roll) => {
    const isRanged = item.system.actionType === 'rwak' || item.system.actionType === 'rsak';
    let initiativeString = isRanged ? '2.' : '1.';
    initiativeString += `${roll.total}`.padStart(2, '0');
    const { actor } = item;
    if (actor && game.settings.get('dnd5e', 'initiativeDexTiebreaker')) initiativeString += `${actor.system.abilities.dex.value}`.padStart(2, '0');
    const initiative = Number(initiativeString);
    const combatant = actor.getActiveTokens()[0]?.combatant;
    if (combatant && game.combat.combatants.has(combatant.id)) return combatant.update({ initiative });
});

Hooks.on('targetToken', async (user, targetedToken, isTargeted) => {
    if (!user.isGM) return;

    const controlledTokens = canvas.tokens.controlled;
    for (const controlledToken of controlledTokens) {
        const controlledTokenDoc = controlledToken.document;

        const currentTargets = controlledTokenDoc.getFlag(moduleID, 'targets') || [];
        const index = currentTargets.indexOf(targetedToken.document.uuid);
        if (isTargeted) {
            if (index > -1) continue;
            else currentTargets.push(targetedToken.document.uuid);
        } else {
            if (index > -1) currentTargets.splice(index, 1);
            else continue;
        }

        await controlledTokenDoc.setFlag(moduleID, 'targets', currentTargets);
        controlledToken._applyRenderFlags({ redrawEffects: true });
    }
});

Hooks.on('hoverToken', (token, hoverIn) => {
    const tokenDoc = token.document;
    const targets = tokenDoc.getFlag(moduleID, 'targets') || [];
    if (!targets.length) return;

    for (const targetUuid of targets) {
        const target = fromUuidSync(targetUuid)?.object;
        if (!target) continue;

        if (hoverIn) target._drawTarget({ color: 'black' });
        else target._refreshTarget();
    }
});

Hooks.on('pauseGame', async isPaused => {
    if (isPaused) {
        if (game.user === game.users.find(u => u.isGM && u.active)) {
            const delta = Date.now() - game.settings.get(moduleID, 'timerStartTime');
            const timerDuration = Math.max(0, game.settings.get(moduleID, 'timerDuration') - Math.floor(delta / 1000));
            await game.settings.set(moduleID, 'timerCurrentTime', timerDuration);
        }
        if (timerInterval) clearInterval(timerInterval);
    } else {
        if (game.user === game.users.find(u => u.isGM && u.active)) {
            const timerDuration = game.settings.get(moduleID, 'timerDuration');
            const offsetSec = timerDuration - game.settings.get(moduleID, 'timerCurrentTime');
            const newStartTime = Date.now() - (1000 * offsetSec);
            await game.settings.set(moduleID, 'timerStartTime', newStartTime);
            await game.settings.set(moduleID, 'timerCurrentTime', 0);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return socket.executeForEveryone('startTimer');
        }
    }
});


async function onRoundStart(combat) {
    ui.combat.render();

    if (game.user === game.users.find(u => u.isGM && u.active)) {
        for (const token of canvas.tokens.placeables) {
            if ((token.document?.getFlag(moduleID, 'targets') || []).length) {
                await token.document.unsetFlag(moduleID, 'targets');
                token._applyRenderFlags({ redrawEffects: true });
            }
        }
        await game.settings.set(moduleID, 'timerStartTime', 0);
        await game.settings.set(moduleID, 'timerCurrentTime', 0);
        await combat.resetAll();
        return socket.executeForEveryone('startTimer');
    }
};

function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    const startTime = game.settings.get(moduleID, 'timerStartTime');
    if (!startTime) return;
    if (game.paused) return;

    timerInterval = setInterval(function () {
        const delta = Date.now() - startTime;
        const timerDuration = game.settings.get(moduleID, 'timerDuration') - Math.floor(delta / 1000);
        const timerDiv = document.querySelector(`div.${moduleID}-timer`);

        if (timerDuration <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            timerDiv.innerText = 'Time: --';

            if (game.user === game.users.find(u => u.isGM && u.active)) {
                game.settings.set(moduleID, 'timerStartTime', 0);
                return ui.combat.render();
            }
        } else timerDiv.innerText = 'Time: ' + `${timerDuration}`.padStart(2, '0');
    }, 100);
}

function newSortCombatants(a, b) {
    const ia = Number.isNumeric(a.initiative) ? a.initiative : Infinity;
    const ib = Number.isNumeric(b.initiative) ? b.initiative : Infinity;
    return (ib - ia) || (a.id > b.id ? 1 : -1);
}

async function drawTargets(wrapped) {
    await wrapped();

    const promises = [];
    const targets = this.document.getFlag(moduleID, 'targets') || [];
    for (const targetUuid of targets) {
        const targetToken = await fromUuid(targetUuid);
        const img = targetToken.texture.src;
        promises.push(this._drawEffect(img));
    }
    await Promise.allSettled(promises);

    this.effects.sortChildren();
    this.effects.renderable = true;
    this.renderFlags.set({ refreshEffects: true });
}