/**
 * East Wing late-joiner synchronisation.
 *
 * A player who joins a run already in progress must inherit the starter's world:
 * the same dungeon instance, the same canonical enemies (no second set spawned for
 * them), enemies the starter already killed staying dead, enemies the starter only
 * wounded keeping their damage, and the same shared clear progress.
 *
 * These all run with server-authority AI active for JC_Mini2 (see
 * AILogic.runsServerAuthorityAI), which is what makes the canonical entities — rather
 * than each client's local proxies — the source of truth.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { AILogic } from '../core/AILogic';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import { getSharedDungeonProgressTotals, recomputeSharedDungeonProgress } from '../core/SharedDungeonProgress';
import { DungeonSpawnLoader, DungeonSpawnConfig } from '../data/DungeonSpawnLoader';
import { NpcLoader } from '../data/NpcLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = ReturnType<typeof createFakeClient>;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) LevelConfig.load(dataDir);
    if (Object.keys(GameData.ENTTYPES).length === 0) GameData.load(dataDir);
    if (NpcLoader.getRawNpcsForLevel('JC_Mini2').length === 0) NpcLoader.load(dataDir);
}

function getConfig(): DungeonSpawnConfig {
    const config = DungeonSpawnLoader.getSpawnConfigForLevel('JC_Mini2');
    assert.ok(config, 'East Wing generated dungeon spawn config should load');
    return config as DungeonSpawnConfig;
}

function createFakeClient(name: string, instanceId: string, token: number, roomId: number) {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: 'JC_Mini2', x: 100, y: 200 }
        },
        currentLevel: 'JC_Mini2',
        levelInstanceId: instanceId,
        syncAnchorStartedAt: token,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function attachPlayer(client: FakeClient): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 100,
            y: 200,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        ownerToken: client.token,
        ownerUserId: client.userId,
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp
    };
    client.entities.set(client.clientEntID, player);
    client.knownEntityIds.add(client.clientEntID);

    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(client.clientEntID, player);
}

function setParty(...clients: FakeClient[]): void {
    const partyId = 8802;
    const members = clients.map((client) => client.character.name);
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
    GlobalState.partyGroups.set(partyId, { id: partyId, leader: members[0], members, locked: false });
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildClientHostileFullUpdate(entityId: number, name: string, x: number, y: number, roomId: number): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x,
        y,
        v: 0,
        team: EntityTeam.ENEMY,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function parseDestroy(payload: Buffer): { entityId: number } {
    const br = new BitReader(payload);
    return { entityId: br.readMethod4() };
}

function attachProxy(client: FakeClient, localId: number, enemyIndex: number): void {
    const enemy = getConfig().enemies[enemyIndex];
    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(
            localId,
            String(enemy.type),
            Number(enemy.x),
            Number(enemy.y),
            Number(enemy.roomId ?? 0)
        )
    );
}

function getHostiles(scope: string): any[] {
    return Array.from(GlobalState.levelEntities.get(scope)?.values() ?? [])
        .filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY);
}

function canonicalId(enemyIndex: number): number {
    return Number(getConfig().enemies[enemyIndex].canonicalId ?? getConfig().enemies[enemyIndex].id);
}

/** Server AI must actually be the authority, otherwise the rest of this file proves nothing. */
function testServerAuthorityAiIsActive(): void {
    assert.equal(
        AILogic.runsServerAuthorityAI('JC_Mini2'),
        true,
        'JC_Mini2 must run server-authority AI for late-joiner sync to be server-driven'
    );
    assert.equal(
        EntityHandler.usesServerAuthorityHostiles('JC_Mini2'),
        true,
        'JC_Mini2 must use server-authority hostiles'
    );
}

/**
 * The core of the request: the joiner must land in the starter's instance and must NOT
 * get a second set of enemies spawned for them.
 */
async function testJoinerSharesInstanceAndEnemySet(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-sync-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-sync-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    assert.equal(getHostiles(scope).length, 35, 'starter should seed the full canonical roster');

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    assert.equal(
        joiner.levelInstanceId,
        starter.levelInstanceId,
        'joiner must adopt the starter dungeon instance instead of opening a private one'
    );

    const joinerScope = getLevelScopeKey(joiner.currentLevel, joiner.levelInstanceId);
    assert.equal(joinerScope, scope, 'both players must resolve to one shared level scope');
    assert.equal(
        getHostiles(scope).length,
        35,
        'joining must not spawn a second set of enemies — still exactly the canonical roster'
    );
}

/**
 * The real-world ordering: the starter is already inside the dungeon when the party is
 * formed, so their session was indexed while they still had no party.
 *
 * This used to strand the two players in separate instances — each with their own five
 * enemies — because `GlobalState.getSessionsInParty` returned the first (incomplete) set
 * it found and never rebuilt it, so the joiner could not see the starter as a scope
 * anchor. Regression guard for that self-healing rebuild.
 */
async function testPartyFormedAfterStarterEnteredStillShares(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-late-party-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-late-party-joiner', 63188, 1);

    // Starter enters with NO party yet — indexed with partyId 0.
    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const starterScope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);
    assert.equal(getHostiles(starterScope).length, 35, 'starter should have seeded the full canonical roster');

    // Only now does the party form.
    setParty(starter, joiner);

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    assert.equal(
        GlobalState.getSessionsInParty(8802).size,
        2,
        'party session index must self-heal to include the member indexed before the party existed'
    );
    assert.equal(
        joiner.levelInstanceId,
        starter.levelInstanceId,
        'joiner must still adopt the starter instance when the party formed after entry'
    );
    assert.equal(
        getHostiles(getLevelScopeKey(joiner.currentLevel, joiner.levelInstanceId)).length,
        35,
        'joiner must not get a private second set of enemies'
    );
}

/** Enemies the starter already killed must stay dead for the joiner. */
async function testStarterKillsStayDeadForJoiner(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-dead-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-dead-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    // Starter kills enemy #0.
    attachProxy(starter, 500001, 0);
    const victim = GlobalState.levelEntities.get(scope)?.get(canonicalId(0));
    assert.ok(victim, 'canonical enemy 0 should exist');
    await CombatHandler.handlePowerHit(
        starter as never,
        buildPowerHitPayload(500001, starter.clientEntID, Math.round(Number(victim.hp ?? 0)) + 999)
    );
    assert.equal(victim.dead, true, 'starter should have killed canonical enemy 0');

    // Joiner arrives afterwards.
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    joiner.sentPackets.length = 0;
    attachProxy(joiner, 600001, 0);

    assert.equal(
        EntityHandler.resolveEntityAlias(joiner as never, 600001),
        canonicalId(0),
        'joiner local proxy must alias onto the dead canonical enemy, not a new entity'
    );
    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'joiner proxy for an already-dead enemy must be destroyed, not revived'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.get(canonicalId(0))?.dead,
        true,
        'canonical enemy must remain dead after the joiner attaches'
    );
    assert.equal(getHostiles(scope).length, 35, 'joiner must not add a sixth hostile');
}

/** A wounded-but-alive enemy must keep the starter's damage for the joiner. */
async function testWoundedEnemyKeepsDamageForJoiner(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-wound-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-wound-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    attachProxy(starter, 500001, 0);
    const target = GlobalState.levelEntities.get(scope)?.get(canonicalId(0));
    const fullHp = Math.round(Number(target.maxHp ?? 0));
    assert.ok(fullHp > 100, 'canonical enemy should carry level-50 maxHp');

    await CombatHandler.handlePowerHit(
        starter as never,
        buildPowerHitPayload(500001, starter.clientEntID, Math.floor(fullHp / 4))
    );
    const woundedHp = Math.round(Number(target.hp ?? 0));
    assert.ok(woundedHp > 0 && woundedHp < fullHp, 'enemy should be wounded but alive');

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);
    attachProxy(joiner, 600001, 0);

    assert.equal(
        Math.round(Number(GlobalState.levelEntities.get(scope)?.get(canonicalId(0))?.hp ?? 0)),
        woundedHp,
        'joining must not heal the wounded enemy back to full'
    );
}

/**
 * The exact reported scenario: the starter clears the WHOLE dungeon, and only then does
 * the second player join. An empty dungeon must stay empty — the joiner must not trigger
 * a "fresh run" reset that re-spawns all five enemies into a private instance.
 *
 * Both `resetFinishedDungeonRunScope` and `resetServerAuthorityScopeForFreshRun` are
 * guarded by `hasOtherActiveSessionInScope`, so this only holds while the two players
 * actually share one scope — which is what makes this the end-to-end guard.
 */
async function testJoinerAfterFullClearGetsNoFreshEnemies(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-cleared-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-cleared-joiner', 63188, 1);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    // Clear the entire dungeon.
    for (let index = 0; index < 35; index += 1) {
        const localId = 500001 + index;
        attachProxy(starter, localId, index);
        const enemy = GlobalState.levelEntities.get(scope)?.get(canonicalId(index));
        assert.ok(enemy, `canonical enemy ${index} should exist`);
        await CombatHandler.handlePowerHit(
            starter as never,
            buildPowerHitPayload(localId, starter.clientEntID, Math.round(Number(enemy.hp ?? 0)) + 999)
        );
    }

    const aliveAfterClear = getHostiles(scope).filter((entity) => !entity.dead);
    assert.equal(aliveAfterClear.length, 0, 'starter should have cleared every enemy');
    assert.deepEqual(
        getSharedDungeonProgressTotals(scope),
        { total: 35, defeated: 35 },
        'dungeon should read as fully cleared'
    );

    // Party forms, then the second player enters the cleared dungeon.
    setParty(starter, joiner);
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    const joinerScope = getLevelScopeKey(joiner.currentLevel, joiner.levelInstanceId);
    assert.equal(joinerScope, scope, 'joiner must land in the starter cleared scope');
    assert.equal(
        getHostiles(joinerScope).filter((entity) => !entity.dead).length,
        0,
        'joining a cleared dungeon must not spawn a fresh set of enemies'
    );
    assert.deepEqual(
        getSharedDungeonProgressTotals(joinerScope),
        { total: 35, defeated: 35 },
        'joiner must inherit the fully-cleared progress rather than restarting at zero'
    );
}

/**
 * A client-spawned hostile that matches nothing in the canonical spawn table must be
 * rejected outright, not registered as a `clientSpawned` entity — otherwise it exists
 * only for the session whose client invented it.
 *
 * Note the roster is the *whole* placed display list (35 hostiles), not just the five
 * named ActionScript cues, so real East Wing enemies like ShadeSummoner2 must NOT trip
 * this path. The entity used here is deliberately from another realm entirely.
 */
async function testUnmatchedClientHostileIsRejected(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-stray-starter', 13933, 1);
    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);
    assert.equal(getHostiles(scope).length, 35, 'baseline should be the full canonical roster');

    starter.sentPackets.length = 0;
    const strayId = 14936708;
    EntityHandler.handleEntityFullUpdate(
        starter as never,
        buildClientHostileFullUpdate(strayId, 'AncientDragonGold', 15049, 4713, 0)
    );

    assert.equal(
        getHostiles(scope).length,
        35,
        'a stray client hostile must not be added to the canonical level map'
    );
    assert.equal(
        getHostiles(scope).some((entity) => String(entity.name ?? '') === 'AncientDragonGold'),
        false,
        'an enemy from another dungeon must never enter the shared scope'
    );
    assert.equal(
        starter.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === strayId),
        true,
        'the stray client hostile should be destroyed on the client that invented it'
    );

    // Chests arrive on the hostile team but are loot, not enemies. Rejecting them would
    // strip the player's rewards, so they must survive the same unmatched path.
    starter.sentPackets.length = 0;
    const chestId = 7816135; // also from the live report
    EntityHandler.handleEntityFullUpdate(
        starter as never,
        buildClientHostileFullUpdate(chestId, 'TreasureChestEmpty', 15100, 3300, 1)
    );
    assert.equal(
        starter.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === chestId),
        false,
        'a treasure chest must NOT be rejected as an unmatched hostile'
    );
}

/** Clear progress is a property of the run, not of the player. */
async function testProgressIsSharedWithJoiner(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-prog-starter', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-prog-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    attachProxy(starter, 500001, 0);
    const victim = GlobalState.levelEntities.get(scope)?.get(canonicalId(0));
    await CombatHandler.handlePowerHit(
        starter as never,
        buildPowerHitPayload(500001, starter.clientEntID, Math.round(Number(victim.hp ?? 0)) + 999)
    );

    assert.deepEqual(
        getSharedDungeonProgressTotals(scope),
        { total: 35, defeated: 1 },
        'progress totals should reflect the starter kill'
    );

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    const joinerScope = getLevelScopeKey(joiner.currentLevel, joiner.levelInstanceId);
    assert.deepEqual(
        getSharedDungeonProgressTotals(joinerScope),
        { total: 35, defeated: 1 },
        'joiner must inherit the run progress — totals must not double to ten'
    );
    assert.equal(
        recomputeSharedDungeonProgress(joinerScope)?.progress,
        2,
        'joiner should see the same clear progress the starter has (floor(1/35*100))'
    );
}

/**
 * Both players must keep getting progress updates even when `sessionsByLevelScope` has
 * gone stale for one of them.
 *
 * Observed live: two party members in one scope, and a kill broadcast that reached only
 * `[Lanorut]` while Telahair was standing right there — their bars then read 20% and 0%.
 * The index is refreshed lazily, so correctness-critical fan-out resolves its audience
 * from live sessions instead.
 */
async function testProgressBroadcastSurvivesStaleLevelScopeIndex(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-stale-idx', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-stale-idx-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);
    assert.equal(getLevelScopeKey(joiner.currentLevel, joiner.levelInstanceId), scope, 'both must share the scope');

    // Corrupt the index exactly the way the live server did: drop one live player.
    GlobalState.sessionsByLevelScope.get(scope)?.delete(starter as never);

    starter.sentPackets.length = 0;
    joiner.sentPackets.length = 0;
    LevelHandler.refreshSharedDungeonQuestProgress(scope);

    const gotProgress = (client: FakeClient): boolean =>
        client.sentPackets.some((packet) => packet.id === 0xB7);
    assert.equal(gotProgress(starter), true, 'the player missing from the index must still receive progress');
    assert.equal(gotProgress(joiner), true, 'the indexed player must still receive progress');
}

/**
 * A joiner must not be able to wipe a run that someone is still playing just because the
 * level scope index forgot about them — that reset re-spawns every enemy.
 */
async function testStaleIndexDoesNotLetJoinerResetLiveRun(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-stale-reset', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-stale-reset-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    // Starter kills one enemy so a reset would be observable.
    attachProxy(starter, 500001, 0);
    const victim = GlobalState.levelEntities.get(scope)?.get(canonicalId(0));
    await CombatHandler.handlePowerHit(
        starter as never,
        buildPowerHitPayload(500001, starter.clientEntID, Math.round(Number(victim.hp ?? 0)) + 999)
    );
    assert.equal(victim.dead, true, 'starter should have killed the first enemy');

    GlobalState.sessionsByLevelScope.get(scope)?.delete(starter as never);

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    assert.equal(
        GlobalState.levelEntities.get(scope)?.get(canonicalId(0))?.dead,
        true,
        'the killed enemy must stay dead — the run must not be reset behind a stale index'
    );
    assert.deepEqual(
        getSharedDungeonProgressTotals(scope),
        { total: 35, defeated: 1 },
        'progress must survive the joiner entering'
    );
}

/**
 * The reported scenario at full scale: the starter kills part of the dungeon, then the
 * joiner's client spawns local proxies for the ENTIRE 35-enemy roster — the way the real
 * Flash client does on level load, with roomId 0 and a Y that has settled onto the floor.
 *
 * Every proxy standing in for an already-dead enemy must be destroyed, and no dead enemy
 * may come back alive. This cannot rely on the spawnKey/fingerprint paths: those key on
 * `name:roomId:x/100:y/100`, which client proxies never reproduce.
 */
async function testJoinerFullProxySweepKeepsKilledEnemiesDead(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-sweep', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-sweep-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    // Starter clears the first six enemies.
    const killedIndexes = [0, 1, 2, 3, 4, 5];
    for (const index of killedIndexes) {
        const localId = 500001 + index;
        attachProxy(starter, localId, index);
        const enemy = GlobalState.levelEntities.get(scope)?.get(canonicalId(index));
        await CombatHandler.handlePowerHit(
            starter as never,
            buildPowerHitPayload(localId, starter.clientEntID, Math.round(Number(enemy.hp ?? 0)) + 999)
        );
        assert.equal(enemy.dead, true, `starter should have killed enemy ${index}`);
    }

    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);
    joiner.sentPackets.length = 0;

    // The joiner's client announces the whole roster the way Flash really does.
    const roster = getConfig().enemies;
    const localIdFor = (index: number): number => 600001 + index;
    roster.forEach((enemy, index) => {
        EntityHandler.handleEntityFullUpdate(
            joiner as never,
            buildClientHostileFullUpdate(
                localIdFor(index),
                String(enemy.type),
                Number(enemy.x),
                Number(enemy.y) + 45, // settled onto the floor, like the live client
                0 // the live client reports roomId 0 for these
            )
        );
    });

    const destroyed = new Set(
        joiner.sentPackets
            .filter((packet) => packet.id === 0x0D)
            .map((packet) => parseDestroy(packet.payload).entityId)
    );

    for (const index of killedIndexes) {
        assert.equal(
            destroyed.has(localIdFor(index)),
            true,
            `proxy for already-dead enemy ${index} (${roster[index].type}) must be destroyed for the joiner`
        );
        assert.equal(
            GlobalState.levelEntities.get(scope)?.get(canonicalId(index))?.dead,
            true,
            `canonical enemy ${index} must stay dead after the joiner's sweep`
        );
    }

    assert.equal(
        getHostiles(scope).length,
        35,
        'the sweep must not add any new hostiles to the shared scope'
    );
    assert.equal(
        getHostiles(scope).filter((entity) => !entity.dead).length,
        35 - killedIndexes.length,
        'exactly the un-killed enemies may remain alive'
    );
    assert.deepEqual(
        getSharedDungeonProgressTotals(scope),
        { total: 35, defeated: killedIndexes.length },
        'progress must still reflect only the starter kills'
    );
}

/**
 * The joiner must inherit the party's room progress, not arrive with a blank slate.
 *
 * `handleEnterWorld` clears `startedRoomEvents` and `shouldSkipDungeonRoomProgressSync` is
 * true for every shared-progress dungeon, so nothing else fills this in for JC_Mini2 — the
 * joiner's own saved DungeonSnapshot would record a run with zero started rooms while the
 * rest of the party was deep into it.
 */
async function testJoinerAdoptsPartyRoomProgress(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-rooms', 13933, 1);
    const joiner = createFakeClient('Telahair', 'ew-rooms-joiner', 63188, 1);
    setParty(starter, joiner);

    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);

    // The starter has worked through rooms 1 and 2.
    (starter as any).startedRoomEvents = new Set<string>(['JC_Mini2:1', 'JC_Mini2:2']);
    // ...and something from an unrelated level must not leak across.
    (starter as any).startedRoomEvents.add('JC_Mission10:7');

    (joiner as any).startedRoomEvents = new Set<string>();
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    const adopted = (joiner as any).startedRoomEvents as Set<string>;
    assert.equal(adopted.has('JC_Mini2:1'), true, 'joiner must inherit started room 1');
    assert.equal(adopted.has('JC_Mini2:2'), true, 'joiner must inherit started room 2');
    assert.equal(
        adopted.has('JC_Mission10:7'),
        false,
        'room progress from another level must never leak into this run'
    );
}

/**
 * Two proxies must never bind to the same canonical enemy.
 *
 * Room 1 holds two BoneFiends about 190px apart. Observed live, both of their proxies
 * resolved to canonical 920009 while 920008 was left unclaimed:
 *   proxy bonefiend local=6772599 -> canonical=920009
 *   proxy bonefiend local=6838135 -> canonical=920009
 * A proxy bound to the wrong twin inherits that twin's life state, so a dead enemy can be
 * reported alive and never destroyed — which is how killed enemies stayed on the joiner's
 * screen. The match radius made it worse: it was only enforced in canonical-visible mode.
 */
async function testProxiesDoNotShareOneCanonical(): Promise<void> {
    const starter = createFakeClient('Zeus', 'ew-twins', 13933, 1);
    attachPlayer(starter);
    GlobalState.sessionsByToken.set(starter.token, starter as never);
    EntityHandler.sendInitialLevelEntities(starter as never, starter.currentLevel);
    const scope = getLevelScopeKey(starter.currentLevel, starter.levelInstanceId);

    const roster = getConfig().enemies;
    const twins = roster
        .map((enemy, index) => ({ enemy, index }))
        .filter((entry) => String(entry.enemy.type) === 'BoneFiend' && Number(entry.enemy.roomId) === 1);
    assert.equal(twins.length, 2, 'room 1 should hold exactly two BoneFiends to exercise this');

    // Kill the first twin only.
    const deadTwin = twins[0];
    attachProxy(starter, 500001, deadTwin.index);
    const deadCanonical = GlobalState.levelEntities.get(scope)?.get(canonicalId(deadTwin.index));
    await CombatHandler.handlePowerHit(
        starter as never,
        buildPowerHitPayload(500001, starter.clientEntID, Math.round(Number(deadCanonical.hp ?? 0)) + 999)
    );
    assert.equal(deadCanonical.dead, true, 'the first BoneFiend should be dead');

    // A joiner announces both twins the way the real client does.
    const joiner = createFakeClient('Telahair', 'ew-twins-joiner', 63188, 1);
    setParty(starter, joiner);
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);

    for (const twin of twins) {
        EntityHandler.handleEntityFullUpdate(
            joiner as never,
            buildClientHostileFullUpdate(
                600000 + twin.index,
                String(twin.enemy.type),
                Number(twin.enemy.x),
                Number(twin.enemy.y) + 45,
                0
            )
        );
    }

    const boundCanonicals = twins
        .map((twin) => EntityHandler.resolveEntityAlias(joiner as never, 600000 + twin.index))
        .filter((id) => Number(id) > 0);
    assert.equal(
        new Set(boundCanonicals).size,
        boundCanonicals.length,
        'each proxy must bind to a distinct canonical — no two may share one'
    );

    const deadProxyDestroyed = joiner.sentPackets.some(
        (packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600000 + deadTwin.index
    );
    assert.equal(deadProxyDestroyed, true, 'the proxy standing in for the dead twin must be destroyed');
    assert.equal(
        GlobalState.levelEntities.get(scope)?.get(canonicalId(twins[1].index))?.dead ?? false,
        false,
        'the surviving twin must stay alive — its proxy must not have been bound to the dead one'
    );
}

function resetRuntime(): void {
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();
    (EntityHandler as any).serverAuthoritySeededScopes?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedIdsByScope?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope?.clear?.();
}

async function main(): Promise<void> {
    const saved = {
        levelEntities: new Map(GlobalState.levelEntities),
        sessionsByToken: new Map(GlobalState.sessionsByToken),
        levelQuestProgress: new Map(GlobalState.levelQuestProgress),
        combatContributions: new Map(GlobalState.combatContributions),
        entityLifeNonces: new Map(GlobalState.entityLifeNonces),
        entityLastRewardNonces: new Map(GlobalState.entityLastRewardNonces),
        partyByMember: new Map(GlobalState.partyByMember),
        partyGroups: new Map(GlobalState.partyGroups)
    };

    ensureDataLoaded();
    try {
        resetRuntime();
        testServerAuthorityAiIsActive();

        resetRuntime();
        await testJoinerSharesInstanceAndEnemySet();

        resetRuntime();
        await testPartyFormedAfterStarterEnteredStillShares();

        resetRuntime();
        await testStarterKillsStayDeadForJoiner();

        resetRuntime();
        await testWoundedEnemyKeepsDamageForJoiner();

        resetRuntime();
        await testUnmatchedClientHostileIsRejected();

        resetRuntime();
        await testJoinerAfterFullClearGetsNoFreshEnemies();

        resetRuntime();
        await testProgressIsSharedWithJoiner();

        resetRuntime();
        await testProgressBroadcastSurvivesStaleLevelScopeIndex();

        resetRuntime();
        await testStaleIndexDoesNotLetJoinerResetLiveRun();

        resetRuntime();
        await testJoinerFullProxySweepKeepsKilledEnemiesDead();

        resetRuntime();
        await testJoinerAdoptsPartyRoomProgress();

        resetRuntime();
        await testProxiesDoNotShareOneCanonical();

        console.log('east_wing_late_joiner_sync_regression: ok');
    } catch (error) {
        console.error('east_wing_late_joiner_sync_regression: failed');
        console.error(error);
        process.exitCode = 1;
    } finally {
        resetRuntime();
        for (const [key, value] of saved.levelEntities) GlobalState.levelEntities.set(key, value);
        for (const [key, value] of saved.sessionsByToken) GlobalState.sessionsByToken.set(key, value);
        for (const [key, value] of saved.levelQuestProgress) GlobalState.levelQuestProgress.set(key, value);
        for (const [key, value] of saved.combatContributions) GlobalState.combatContributions.set(key, value);
        for (const [key, value] of saved.entityLifeNonces) GlobalState.entityLifeNonces.set(key, value);
        for (const [key, value] of saved.entityLastRewardNonces) GlobalState.entityLastRewardNonces.set(key, value);
        for (const [key, value] of saved.partyByMember) GlobalState.partyByMember.set(key, value);
        for (const [key, value] of saved.partyGroups) GlobalState.partyGroups.set(key, value);
    }
}

void main();
