/// <reference types="node" />

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Client } from '../core/Client';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { clearScopeRuntimeLevel, getScopeRuntimeLevel } from '../core/RuntimeLevel';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { PacketRouter } from '../network/packetRouter';

// Reported from a live two-player East Wing run, as three separate complaints that all
// come back to one thing -- the party is not one run:
//
//   1. after a door transition the two players stop seeing each other,
//   2. a level 22 and a level 50 fight enemies at different difficulties,
//   3. both attack the same boss, but only the attacker's screen shows it take damage,
//      and when it dies it dies on that screen alone.
//
// (1) and (3) are the same defect seen from two sides: everything a party shares is
// fanned out over `sessionsByLevelScope` or over the viewer's bound copy of a shared
// hostile, and both could silently omit a player who was standing right there.
const DUNGEON_LEVEL = 'JC_Mini2';
const INSTANCE_ID = 'party-sync';
const SCOPE = getLevelScopeKey(DUNGEON_LEVEL, INSTANCE_ID);

class FakeSocket extends EventEmitter {
    destroyed = false;
    readyState = 'open';
    remoteAddress = '127.0.0.1';
    remotePort = 12345;
    cork(): void {}
    uncork(): void {}
    write(): boolean { return true; }
    end(): void { this.readyState = 'closed'; }
}

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEON_LEVEL)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createClient(name: string, token: number, level: number): Client {
    const client = new Client(new FakeSocket() as never, new PacketRouter());
    client.userId = token;
    client.character = {
        name,
        level,
        xp: 0,
        CurrentLevel: { name: DUNGEON_LEVEL, x: 1000, y: 1000 }
    } as never;
    client.token = token;
    client.currentLevel = DUNGEON_LEVEL;
    client.levelInstanceId = INSTANCE_ID;
    client.currentRoomId = 1;
    client.clientEntID = token + 1000;
    client.playerSpawned = true;
    GlobalState.sessionsByToken.set(token, client);
    return client;
}

function resetState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    clearScopeRuntimeLevel(SCOPE);
}

/**
 * The index the whole party fan-out runs on is derived from four fields on the session.
 * Walking through a door writes three of them, and a single write that forgot to reindex
 * used to drop that player out of the scope for good -- so nobody was sent to them and
 * they were sent to nobody, while their own view of the scope still looked fine.
 */
function testScopeIndexFollowsTheSessionThroughADoor(): void {
    const host = createClient('Telahair', 71001, 50);
    const joiner = createClient('Lanorut', 71002, 22);

    assert.deepEqual(
        new Set(GlobalState.getSessionsInLevelScope(SCOPE)),
        new Set([host, joiner]),
        'both players should be indexed in the shared dungeon scope'
    );

    // A door inside the dungeon: room changes, and on a re-entry the instance is
    // re-stamped with the very same value.
    joiner.currentRoomId = 3;
    joiner.levelInstanceId = INSTANCE_ID;

    assert.deepEqual(
        new Set(GlobalState.getSessionsInLevelScope(SCOPE)),
        new Set([host, joiner]),
        'a room change inside the dungeon must not drop a player out of the level scope'
    );
    assert.deepEqual(
        new Set(GlobalState.getSessionsInRoom(SCOPE, 3)),
        new Set([joiner]),
        'the room index must follow the player through the door'
    );

    // Leaving for another instance must actually remove them, or the opposite bug
    // (ghosts in a run they left) replaces the one being fixed.
    joiner.levelInstanceId = 'somewhere-else';
    assert.deepEqual(
        new Set(GlobalState.getSessionsInLevelScope(SCOPE)),
        new Set([host]),
        'a player who really left the instance must leave the index with it'
    );
}

/**
 * Difficulty is the dungeon's, not the roster's. Two players of different levels in one
 * run must be handed one number, and it must be the number the dungeon is authored at
 * rather than whatever the highest player happens to be.
 */
function testEnemyDifficultyIsTheDungeonsOwn(): void {
    const veteran = createClient('Telahair', 72001, 50);
    const rookie = createClient('Lanorut', 72002, 22);
    const authoredLevel = LevelConfig.getAuthoredDungeonEnemyLevel(DUNGEON_LEVEL);

    assert.ok(authoredLevel > 0, `${DUNGEON_LEVEL} should carry an authored dungeon tier`);
    assert.equal(
        getScopeRuntimeLevel(SCOPE, veteran, 1),
        authoredLevel,
        'the level 50 must see the dungeon at its own recommended difficulty'
    );
    assert.equal(
        getScopeRuntimeLevel(SCOPE, rookie, 1),
        authoredLevel,
        'the level 22 must see exactly the same difficulty as the level 50'
    );

    // And the number must not move when the roster does, in either direction.
    GlobalState.sessionsByToken.delete(veteran.token);
    assert.equal(
        getScopeRuntimeLevel(SCOPE, rookie, 1),
        authoredLevel,
        'enemies must not re-scale because the highest level player left'
    );
}

function createSharedBoss(): any {
    return {
        id: 920024,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        roomId: 3,
        clientSpawned: false,
        x: 14000,
        y: 5000,
        hp: 100000,
        maxHp: 100000,
        dead: false,
        destroyed: false
    };
}

/**
 * The boss desync. Every health/state/death relay resolves the viewer's own id for the
 * shared hostile and skips the viewer when there is none, so a party member whose copy
 * was never bound received nothing at all: full health bar, and a boss that never died.
 */
function testUnboundBossCopyStillResolvesForTheViewer(): void {
    const attacker = createClient('Telahair', 73001, 50);
    const bystander = createClient('Lanorut', 73002, 22);
    attacker.currentRoomId = 3;
    bystander.currentRoomId = 3;

    const boss = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));

    // The attacker's copy is bound the ordinary way.
    EntityHandler.registerCanonicalHostileAlias(attacker, SCOPE, boss, 500001, 'test_attach');

    // The bystander is drawing the same boss but the server never bound their copy.
    bystander.entities.set(600001, {
        id: 600001,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: 14020,
        y: 5010,
        hp: 100000,
        maxHp: 100000
    });

    const attackerView = EntityHandler.resolveHostileLocalIdForViewer(attacker, SCOPE, boss.id, 'test');
    assert.equal(attackerView.ok, true, 'the attacker should resolve their bound boss copy');
    assert.equal(attackerView.localId, 500001, 'the attacker should resolve their own local boss id');

    const bystanderView = EntityHandler.resolveHostileLocalIdForViewer(bystander, SCOPE, boss.id, 'test');
    assert.equal(
        bystanderView.ok,
        true,
        'a party member looking at the same boss must not be skipped by every health and death relay'
    );
    assert.equal(bystanderView.localId, 600001, 'the bystander should resolve their own copy of the boss');

    // The binding is now recorded, so the next relay takes the fast path.
    assert.equal(
        EntityHandler.getRegisteredHostileLocalIdForViewer(bystander, boss),
        600001,
        'adopting the copy must register it, not re-resolve on every packet'
    );
}

/** A same-named enemy in another room is not the same enemy. */
function testDistantCopyIsNotAdopted(): void {
    const bystander = createClient('Lanorut', 74002, 22);
    const boss = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));

    bystander.entities.set(600002, {
        id: 600002,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: boss.x + 4000,
        y: boss.y + 4000,
        hp: 100000,
        maxHp: 100000
    });

    const view = EntityHandler.resolveHostileLocalIdForViewer(bystander, SCOPE, boss.id, 'test');
    assert.equal(view.ok, false, 'a copy on the other side of the level must not be bound to this canonical');
}

/** One canonical, one local copy: never re-bind a canonical a copy already owns. */
function testAdoptionDoesNotDoubleBindACanonical(): void {
    const viewer = createClient('Lanorut', 75002, 22);
    const boss = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));

    EntityHandler.registerCanonicalHostileAlias(viewer, SCOPE, boss, 600003, 'test_attach');
    viewer.entities.set(600004, {
        id: 600004,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: boss.x,
        y: boss.y,
        hp: 100000,
        maxHp: 100000
    });

    const view = EntityHandler.resolveHostileLocalIdForViewer(viewer, SCOPE, boss.id, 'test');
    assert.equal(view.localId, 600003, 'the already bound copy must keep the canonical');
}

/**
 * East Wing's enemies used to be pinned to a flat level 50 by
 * `SERVER_AUTHORITY_ENTITY_LEVEL`, which is neither the dungeon's difficulty nor anything
 * a player could influence. They now carry the level's own tier, and their health pool is
 * sized from that same row.
 */
function testServerAuthorityHostilesUseTheDungeonTier(): void {
    const authoredLevel = LevelConfig.getAuthoredDungeonEnemyLevel(DUNGEON_LEVEL);
    assert.equal(authoredLevel, 29, 'JC_Mini2 is authored at tier 29');
    assert.equal(
        EntityHandler.resolveServerAuthorityEntityLevel(SCOPE),
        authoredLevel,
        'a server-authority hostile in this dungeon must carry the dungeon tier'
    );

    const hostile: any = {
        id: 920005,
        name: 'Ghoul',
        EntName: 'Ghoul',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        clientSpawned: false,
        hp: 0,
        maxHp: 0
    };
    EntityHandler.normalizeServerAuthorityHostileState(SCOPE, hostile);

    assert.equal(hostile.level, authoredLevel, 'normalization must stamp the dungeon tier, not 50');
    assert.equal(
        hostile.maxHp,
        EntityHandler.estimateServerAuthorityHostileMaxHp(hostile, SCOPE),
        'the health pool must come from the dungeon tier row'
    );
    assert.ok(
        hostile.maxHp < EntityHandler.estimateServerAuthorityHostileMaxHp(hostile, 'NotADungeonScope'),
        'tier 29 must size the pool below the old flat level 50 row'
    );
}

/**
 * A door is two connections, and the old one does not always close first. When it closed
 * second it tore down the body its own successor had already spawned -- and the destroy
 * went to everyone except the departing client, so the player who used the door became
 * invisible to the rest of the party while still seeing them.
 */
function testClosingSessionDoesNotDestroyItsSuccessorsBody(): void {
    const walker = createClient('Lanorut', 76001, 22);
    const walkerEntityId = walker.clientEntID;
    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    levelMap.set(walkerEntityId, {
        id: walkerEntityId,
        name: 'Lanorut',
        isPlayer: true,
        x: 14000,
        y: 5000
    });

    // The door: a new connection for the same character logs in and spawns before the old
    // socket's close handler runs.
    const successor = createClient('Lanorut', 76002, 22);
    const successorEntityId = successor.clientEntID;
    levelMap.set(successorEntityId, {
        id: successorEntityId,
        name: 'Lanorut',
        isPlayer: true,
        x: 14100,
        y: 5000
    });
    GlobalState.sessionsByCharacterName.set('lanorut', successor);

    const removed = EntityHandler.removeOwnedEntities(walker);

    assert.ok(
        !removed.includes(successorEntityId),
        'the closing session must not destroy the body its successor already spawned'
    );
    assert.equal(
        levelMap.has(successorEntityId),
        true,
        'the successor body must survive the old connection closing behind it'
    );
    assert.ok(removed.includes(walkerEntityId), 'the closing session must still clean up its own body');
}

/**
 * Seeding another client with a player body is a spawn, and the client only snaps a spawn
 * onto floor within 160px. An airborne live sample outside that window is accepted as-is
 * and the body falls -- the party members raining down at the start of the boss scene.
 */
function testRemoteBodyIsPlacedOnFloorNotOnTheLiveSample(): void {
    const client = createClient('Lanorut', 77001, 22);
    const airborne = {
        id: client.clientEntID,
        isPlayer: true,
        x: 14000,
        y: 3200,
        airborne: true,
        groundedX: 14000,
        groundedY: 5000,
        groundedLevel: DUNGEON_LEVEL,
        groundedAbsolute: true
    };

    const placed = (EntityHandler as any).withGroundedBodyPosition(airborne, DUNGEON_LEVEL);
    assert.equal(placed.y, 5000, 'a body drawn on another screen must go on the confirmed floor sample');
    assert.equal(placed.x, 14000, 'the horizontal position should come from the same confirmed sample');
    assert.equal(airborne.y, 3200, 'the live entity must not be rewritten by the outgoing copy');

    const standing = {
        id: client.clientEntID,
        isPlayer: true,
        x: 14000,
        y: 5000,
        groundedX: 14000,
        groundedY: 5000,
        groundedLevel: DUNGEON_LEVEL,
        groundedAbsolute: true
    };
    assert.equal(
        (EntityHandler as any).withGroundedBodyPosition(standing, DUNGEON_LEVEL),
        standing,
        'a body already standing on its confirmed sample should be sent untouched'
    );
}

/**
 * Player visibility is symmetric and self-healing.
 *
 * It used to be two one-shot half-exchanges: the joiner pulled the others in on spawn, the
 * others were pushed the joiner. Either half failing left the pair permanently one-way --
 * the player who walked through the door saw the party while the party could not see them
 * -- with nothing to retry it.
 */
function testPlayerVisibilityIsExchangedBothWays(): void {
    const host = createClient('Telahair', 78001, 50);
    const joiner = createClient('Lanorut', 78002, 22);
    for (const client of [host, joiner]) {
        client.entities.set(client.clientEntID, {
            id: client.clientEntID,
            isPlayer: true,
            name: client.character?.name,
            x: 14000,
            y: 5000,
            groundedX: 14000,
            groundedY: 5000,
            groundedLevel: DUNGEON_LEVEL,
            groundedAbsolute: true
        });
    }

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        (EntityHandler as any).syncPlayerVisibilityInScope(joiner);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === host.clientEntID),
        'the joiner must be sent the party member already standing there'
    );
    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === joiner.clientEntID),
        'the party member must be sent the joiner in the same pass'
    );
    assert.ok(
        !sent.some((entry) => entry.viewer === entry.subject.toString()),
        'nobody should be sent their own body by the visibility exchange'
    );
}

/**
 * A door inside the dungeon you are already in is a reload of that level, not a join. The
 * party-anchor coordinate must not be replayed as the arrival point: it is measured under
 * another body, possibly in another room, and the client only snaps a spawn onto floor
 * inside a 59px-up/160px-down ray. Anything further is taken as given and the body glides
 * down -- both players falling out of the air at the door and in the boss room behind it.
 */
function testInternalDungeonDoorDoesNotReplayThePartyAnchorPoint(): void {
    const walker: any = {
        character: { name: 'Lanorut', CurrentLevel: { name: DUNGEON_LEVEL, x: 1000, y: 1000 } },
        currentLevel: DUNGEON_LEVEL,
        levelInstanceId: INSTANCE_ID,
        entryLevel: 'Valhaven',
        entryX: 0,
        entryY: 0,
        entryHasCoord: false,
        lastDoorId: 4,
        lastDoorTargetLevel: DUNGEON_LEVEL
    };
    // What the party anchor would have handed over: another player's body, elsewhere.
    const anchorSyncState = { x: 15500, y: 3100, hasCoord: true };

    const spawn = (LevelHandler as any).resolveDungeonExitSpawn(
        walker,
        walker.character,
        DUNGEON_LEVEL,
        DUNGEON_LEVEL,
        anchorSyncState,
        false
    );

    assert.notEqual(spawn.y, 3100, 'a door reload must not drop the player onto the party anchor point');
    assert.deepEqual(
        spawn,
        LevelConfig.getSpawnCoordinates(walker.character, DUNGEON_LEVEL, DUNGEON_LEVEL, 4),
        'a door reload must arrive on the door\'s own authored spawn, or on none at all'
    );

    // Entering the dungeon from outside still lands on the party, which is what the anchor
    // coordinate is for.
    const joiner: any = {
        ...walker,
        currentLevel: 'Valhaven',
        lastDoorTargetLevel: DUNGEON_LEVEL
    };
    const joinSpawn = (LevelHandler as any).resolveDungeonExitSpawn(
        joiner,
        joiner.character,
        'Valhaven',
        DUNGEON_LEVEL,
        anchorSyncState,
        false
    );
    assert.deepEqual(
        joinSpawn,
        { x: 15500, y: 3100, hasCoord: true },
        'entering the dungeon from outside must still arrive on the party anchor'
    );
}

/**
 * A body that is airborne with no confirmed floor sample has nowhere safe to be drawn: the
 * live point is somewhere in open air, and once it is outside the client's snap ray the
 * body is left there and glides to the ground. That is the player materialising above the
 * boss room. The seed is refused instead, and the resync pass delivers it once the client
 * reports standing somewhere.
 */
function testAirborneBodyWithNoFloorSampleIsNotSeeded(): void {
    const airborne = {
        id: 12345,
        isPlayer: true,
        x: 14000,
        y: 3200,
        airborne: true
    };
    assert.equal(
        (EntityHandler as any).withGroundedBodyPosition(airborne, DUNGEON_LEVEL),
        null,
        'an airborne body with no floor sample must not be drawn on a remote screen at all'
    );

    // Standing, but with no sample yet: the live point is the client's own report, so it is
    // usable and must not be refused.
    const standing = { id: 12345, isPlayer: true, x: 14000, y: 5000 };
    assert.equal(
        (EntityHandler as any).withGroundedBodyPosition(standing, DUNGEON_LEVEL),
        standing,
        'a standing body with no stored sample should still be sent as reported'
    );
}

/**
 * The retry must not be pinned to the scope captured when it was scheduled. The scope guard
 * moves a session onto the party's instance after it spawns, and a retry cancelled because
 * the scope "changed" is a retry cancelled exactly when it was needed -- the run where the
 * leader never receives the member who walked through the door.
 */
function testVisibilityResyncSurvivesAScopeChange(): void {
    const host = createClient('Telahair', 79001, 50);
    const joiner = createClient('Lanorut', 79002, 22);
    for (const client of [host, joiner]) {
        client.entities.set(client.clientEntID, {
            id: client.clientEntID,
            isPlayer: true,
            name: client.character?.name,
            x: 14000,
            y: 5000,
            groundedX: 14000,
            groundedY: 5000,
            groundedLevel: DUNGEON_LEVEL,
            groundedAbsolute: true
        });
    }

    const scheduled: Array<() => void> = [];
    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: () => void) => {
        scheduled.push(fn);
        return { unref() {} };
    };
    try {
        EntityHandler.schedulePlayerVisibilityResync(joiner);
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }
    assert.ok(scheduled.length > 0, 'a resync pass should be scheduled');

    // The scope guard adopts the party instance after the joiner spawned.
    host.levelInstanceId = 'adopted-instance';
    joiner.levelInstanceId = 'adopted-instance';

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        for (const fire of scheduled) {
            fire();
        }
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === joiner.clientEntID),
        'the retry must still run after the scope guard moved the session, or the leader never gets the member'
    );
}

/**
 * Health corrections for a shared hostile must be addressed to the viewer's own id.
 *
 * `resolveEntityLocalId` falls back to the canonical id when the viewer has no alias, so a
 * correction for an unbound copy went out under an id that client had never heard of. The
 * enemy took no damage and did not die on that screen until something else rebound it --
 * one player's enemies dying instantly and the other player's dying late.
 */
function testHostileHealthCorrectionsUseTheViewersOwnId(): void {
    const bystander = createClient('Lanorut', 80002, 22);
    bystander.currentRoomId = 3;

    const boss = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));

    // Drawing the boss, never bound by the attach path.
    bystander.entities.set(600011, {
        id: 600011,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: boss.x + 10,
        y: boss.y,
        hp: 100000,
        maxHp: 100000
    });

    const cacheState = (CombatHandler as any).syncServerAuthorityNpcViewerCache(bystander, boss);

    assert.equal(
        cacheState.localId,
        600011,
        'the viewer cache must target the copy that client is actually drawing, not the canonical id'
    );
    assert.equal(
        bystander.entities.has(boss.id),
        false,
        'a health correction must not invent a canonical-id entity the client has never heard of'
    );
}

/**
 * A room change is a single large jump. The other clients keep drawing the body where it
 * was -- the player shown standing in the room they left, at a position with no relation to
 * where they are -- unless the server pushes the authoritative body when the room changes.
 */
function testRoomChangePushesThePlayerToEveryoneElse(): void {
    const host = createClient('Telahair', 81001, 50);
    const walker = createClient('Lanorut', 81002, 22);
    for (const client of [host, walker]) {
        client.entities.set(client.clientEntID, {
            id: client.clientEntID,
            isPlayer: true,
            name: client.character?.name,
            x: 14000,
            y: 5000,
            groundedX: 14000,
            groundedY: 5000,
            groundedLevel: DUNGEON_LEVEL,
            groundedAbsolute: true
        });
    }

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        (LevelHandler as any).cacheRoomId(walker, 3);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.equal(walker.currentRoomId, 3, 'the room change should be recorded');
    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === walker.clientEntID),
        'changing room must push the moving player to the other screens, not leave them in the old room'
    );
}

/**
 * Server-owned hostiles must drop loot, once, for every party member.
 *
 * `handleGrantReward` refuses a client's own reward request on every server-authority level
 * (`requiresCanonicalHostileLootContext`), because the server is meant to grant it. The
 * server side was gated on the opt-in "server draws the enemies" flag, which is off, so the
 * two halves cancelled and every East Wing enemy died dropping nothing at all.
 */
function testServerOwnedHostilesDropLootForTheWholeParty(): void {
    const killer = createClient('Telahair', 82001, 50);
    const partner = createClient('Lanorut', 82002, 22);
    GlobalState.partyGroups.set(8802, {
        id: 8802,
        leader: 'Telahair',
        members: ['Telahair', 'Lanorut'],
        locked: false
    });
    GlobalState.partyByMember.set('telahair', 8802);
    GlobalState.partyByMember.set('lanorut', 8802);
    GlobalState.refreshSessionIndexes(killer);
    GlobalState.refreshSessionIndexes(partner);

    const hostile = createSharedBoss();
    // A finished death: the reward hook only fires once the death transaction is complete.
    hostile.hp = 0;
    hostile.dead = true;
    hostile.destroyed = true;
    hostile.entState = EntityState.DEAD;
    hostile.deathFinalizedAt = Date.now();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[hostile.id, hostile]]));

    (CombatHandler as any).handleServerAuthorityDefeatSideEffects(killer, SCOPE, hostile);

    assert.equal(hostile.lootDropped, true, 'a server-owned hostile must drop loot when it dies');
    assert.ok(String(hostile.lootDropNonce ?? ''), 'the drop must be stamped with a loot nonce');

    const grantedTokens = hostile.lootGrantedTokens as Set<number>;
    assert.ok(grantedTokens?.has(killer.token), 'the killer must receive the drop');
    assert.ok(grantedTokens?.has(partner.token), 'every party member in the run must receive the drop');

    // Idempotent: a second defeat notification must not hand out a second set.
    const grantedCount = grantedTokens.size;
    (CombatHandler as any).handleServerAuthorityDefeatSideEffects(killer, SCOPE, hostile);
    assert.equal(grantedTokens.size, grantedCount, 'a repeated defeat notification must not drop twice');
}

/**
 * Loot belongs on the corpse. `sourceEntity.x/y` is the server's own simulation of the
 * enemy, and on a client-drawn level that has drifted from where anybody saw it standing --
 * which scattered rewards around the room. The position is recorded once, when the death is
 * finalized, from the screen that landed the kill.
 */
function testLootDropsWhereTheEnemyActuallyDied(): void {
    const killer = createClient('Telahair', 83001, 50);
    const hostile = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[hostile.id, hostile]]));

    // The killer's own copy, where that client rendered the enemy when it died. The
    // canonical has drifted well away from it.
    EntityHandler.registerCanonicalHostileAlias(killer, SCOPE, hostile, 500021, 'test_attach');
    killer.entities.set(500021, {
        id: 500021,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: 15880,
        y: 6120
    });

    (CombatHandler as any).recordHostileDeathPosition(killer, SCOPE, hostile.id, hostile);

    assert.equal(hostile.deathX, 15880, 'the drop must be anchored to where the kill happened');
    assert.equal(hostile.deathY, 6120, 'the drop must be anchored to where the kill happened');

    // Recorded once: a later notification must not move the loot off the corpse.
    const localCopy = killer.entities.get(500021);
    localCopy.x = 11000;
    localCopy.y = 3000;
    (CombatHandler as any).recordHostileDeathPosition(killer, SCOPE, hostile.id, hostile);
    assert.equal(hostile.deathX, 15880, 'the death position must be recorded once and stay put');

    // And the reward actually uses it, rather than the canonical's drifted position.
    hostile.hp = 0;
    hostile.dead = true;
    hostile.destroyed = true;
    hostile.entState = EntityState.DEAD;
    hostile.deathFinalizedAt = Date.now();

    const dropPositions: Array<{ x: number; y: number }> = [];
    const originalApply = (RewardHandler as any).applyRewardToRecipient;
    (RewardHandler as any).applyRewardToRecipient = (
        _recipient: Client,
        _reward: any,
        _nonce: unknown,
        _sourceEntity: any,
        dropPosition: { x: number; y: number }
    ) => {
        dropPositions.push(dropPosition);
    };
    try {
        (CombatHandler as any).handleServerAuthorityDefeatSideEffects(killer, SCOPE, hostile);
    } finally {
        (RewardHandler as any).applyRewardToRecipient = originalApply;
    }

    assert.ok(dropPositions.length > 0, 'the death should have produced a drop');
    assert.deepEqual(
        dropPositions[0],
        { x: 15880, y: 6120 },
        'the drop must land on the corpse, not on the canonical entity\'s simulated position'
    );
}

/**
 * The late joiner. A player entering while the anchor is still loading keeps their own
 * instance for a moment, seeds an untouched roster into it, and their client binds to those
 * live copies. When the scope guard moves them onto the party's run they must not carry
 * those bindings with them: enemies the party already killed are dead for them too.
 */
function testJoiningAPartyRunRemovesEnemiesItAlreadyKilled(): void {
    const host = createClient('Telahair', 84001, 50);
    const joiner = createClient('Lanorut', 84002, 22);
    GlobalState.partyGroups.set(8804, {
        id: 8804,
        leader: 'Telahair',
        members: ['Telahair', 'Lanorut'],
        locked: false
    });
    GlobalState.partyByMember.set('telahair', 8804);
    GlobalState.partyByMember.set('lanorut', 8804);
    GlobalState.refreshSessionIndexes(host);
    GlobalState.refreshSessionIndexes(joiner);

    // The party's run: one enemy already killed, one still standing.
    const killed = { ...createSharedBoss(), id: 920005, name: 'Ghoul', EntName: 'Ghoul', x: 12500, y: 5200 };
    killed.hp = 0;
    killed.dead = true;
    killed.destroyed = true;
    killed.entState = EntityState.DEAD;
    const alive = { ...createSharedBoss(), id: 920006, name: 'Ghoul', EntName: 'Ghoul', x: 12900, y: 5200 };
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[killed.id, killed], [alive.id, alive]]));

    // The joiner arrived in a private instance and bound both to their own live copies.
    joiner.levelInstanceId = 'private-run';
    for (const [localId, canonicalId, x] of [[700001, 920005, 12500], [700002, 920006, 12900]] as const) {
        joiner.entities.set(localId, {
            id: localId,
            name: 'Ghoul',
            EntName: 'Ghoul',
            isPlayer: false,
            team: EntityTeam.ENEMY,
            entState: EntityState.ACTIVE,
            x,
            y: 5200,
            hp: 7380,
            maxHp: 7380,
            canonicalEntityId: canonicalId
        });
        joiner.entityIdAliases.set(localId, canonicalId);
    }

    // Driven through the scope guard, so the wiring is covered and not just the helper.
    const adoptedScope = EntityHandler.ensureJcMini1PartySharedScope(joiner, DUNGEON_LEVEL, 'test_scope_adopt');
    assert.equal(adoptedScope, SCOPE, 'the joiner should have been moved onto the party run');

    assert.equal(
        joiner.entities.has(700001),
        false,
        'an enemy the party already killed must not be left standing for the player who joined later'
    );
    assert.ok(
        joiner.entities.has(700002),
        'an enemy the party has not killed yet must survive the reconcile'
    );
}

/**
 * A party member still loading the dungeon already owns the run -- login bound them to its
 * instance. Requiring a spawned body here is what let the next member through the door open
 * a private run instead: their own untouched roster, their own 0% bar, and every enemy the
 * party had already killed back on its feet.
 */
function testLoadingPartyMemberAnchorsTheScope(): void {
    const loadingHost = createClient('Telahair', 85001, 50);
    loadingHost.playerSpawned = false;
    loadingHost.clientEntID = 0;
    loadingHost.entities.clear();

    const joiner = createClient('Lanorut', 85002, 22);
    joiner.levelInstanceId = 'private-run';
    GlobalState.partyGroups.set(8805, {
        id: 8805,
        leader: 'Telahair',
        members: ['Telahair', 'Lanorut'],
        locked: false
    });
    GlobalState.partyByMember.set('telahair', 8805);
    GlobalState.partyByMember.set('lanorut', 8805);
    GlobalState.refreshSessionIndexes(loadingHost);
    GlobalState.refreshSessionIndexes(joiner);

    const adopted = EntityHandler.ensureJcMini1PartySharedScope(joiner, DUNGEON_LEVEL, 'test_loading_anchor');

    assert.equal(adopted, SCOPE, 'a party member still loading must still anchor the run');
    assert.equal(joiner.levelInstanceId, INSTANCE_ID, 'the joiner must adopt the loading member\'s instance');

    // A member walking *out* has had their instance binding cleared, and must not anchor.
    const leaver = createClient('Telahair', 85003, 50);
    leaver.playerSpawned = false;
    leaver.levelInstanceId = '';
    const stranded = createClient('Lanorut', 85004, 22);
    stranded.levelInstanceId = 'own-run';
    GlobalState.partyByMember.set('telahair', 8805);
    GlobalState.partyByMember.set('lanorut', 8805);
    GlobalState.sessionsByToken.delete(loadingHost.token);
    GlobalState.sessionsByToken.delete(joiner.token);
    GlobalState.refreshSessionIndexes(leaver);
    GlobalState.refreshSessionIndexes(stranded);

    EntityHandler.ensureJcMini1PartySharedScope(stranded, DUNGEON_LEVEL, 'test_leaver_anchor');
    assert.equal(
        stranded.levelInstanceId,
        'own-run',
        'a party member walking out of the dungeon must not hand their instance to anybody'
    );
}

/**
 * The progress bar is resolved against the scope the session is in. A joiner who spent a
 * moment in a private run had it resolved there -- 0% -- and nothing re-sent it when the
 * scope guard moved them onto the party's 25% run.
 */
function testAdoptingThePartyRunResendsItsProgress(): void {
    const host = createClient('Telahair', 86001, 50);
    const joiner = createClient('Lanorut', 86002, 22);
    joiner.levelInstanceId = 'private-run';
    GlobalState.partyGroups.set(8806, {
        id: 8806,
        leader: 'Telahair',
        members: ['Telahair', 'Lanorut'],
        locked: false
    });
    GlobalState.partyByMember.set('telahair', 8806);
    GlobalState.partyByMember.set('lanorut', 8806);
    GlobalState.refreshSessionIndexes(host);
    GlobalState.refreshSessionIndexes(joiner);

    let syncedFor: Client | null = null;
    const originalSync = LevelHandler.syncSharedDungeonQuestProgressState;
    (LevelHandler as any).syncSharedDungeonQuestProgressState = (client: Client) => {
        syncedFor = client;
    };
    try {
        EntityHandler.ensureJcMini1PartySharedScope(joiner, DUNGEON_LEVEL, 'test_progress_resync');
    } finally {
        (LevelHandler as any).syncSharedDungeonQuestProgressState = originalSync;
    }

    assert.equal(joiner.levelInstanceId, INSTANCE_ID, 'the joiner should have adopted the party run');
    assert.equal(
        syncedFor,
        joiner,
        'adopting the party run must re-send its progress, or the joiner keeps the empty bar'
    );
}

/**
 * An enemy the party killed before this player arrived must not be shown dying. The HP
 * drain and the DEAD state converge a copy the player was fighting; for a first-sight copy
 * they make the joiner watch it spawn in and die.
 */
function testAlreadyDeadEnemyIsNeverShownToAJoiner(): void {
    const joiner = createClient('Lanorut', 87001, 22);
    const sent: number[] = [];
    (joiner as any).send = (packetId: number) => {
        sent.push(packetId);
    };

    (EntityHandler as any).destroyDeadServerAuthorityLocalProxy(
        joiner,
        { id: 700010, name: 'Ghoul', EntName: 'Ghoul', team: EntityTeam.ENEMY, x: 12500, y: 5200 },
        700010
    );

    assert.deepEqual(sent, [0x0D], 'a never-seen dead enemy should only be removed, never animated into a death');
    assert.equal(joiner.entities.has(700010), false, 'the local copy must not be left behind');
}

/**
 * The reset that wipes a finished run must never fire on one that is being played.
 *
 * "Is anybody standing here" was the only test, and it required a spawned body -- so a
 * single moment where the other player was mid-load read as an empty scope and the joiner's
 * entry deleted the whole run: shared progress back to 0%, every enemy the party had killed
 * standing up again. Exactly the reported "I joined at 25% and it became 0% with the
 * enemies back".
 */
function testJoiningDoesNotWipeARunInProgress(): void {
    const loadingHost = createClient('Telahair', 88001, 50);
    loadingHost.playerSpawned = false;
    loadingHost.clientEntID = 0;
    loadingHost.entities.clear();

    const joiner = createClient('Lanorut', 88002, 22);

    const killed = { ...createSharedBoss(), id: 920005, name: 'Ghoul', EntName: 'Ghoul' };
    killed.hp = 0;
    killed.dead = true;
    killed.destroyed = true;
    killed.entState = EntityState.DEAD;
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[killed.id, killed]]));

    (EntityHandler as any).resetFinishedDungeonRunScope(joiner, DUNGEON_LEVEL);

    assert.ok(
        GlobalState.levelEntities.has(SCOPE),
        'a run whose party member is still loading must not be wiped by the next player entering'
    );
    assert.equal(
        GlobalState.levelEntities.get(SCOPE)?.get(920005)?.dead,
        true,
        'the enemies the party already killed must stay dead'
    );

    // Progress alone is enough to veto it, even with nobody else connected at all.
    GlobalState.sessionsByToken.delete(loadingHost.token);
    GlobalState.levelQuestProgress.set(SCOPE, { progress: 25, authorityToken: loadingHost.token });
    (EntityHandler as any).resetFinishedDungeonRunScope(joiner, DUNGEON_LEVEL);
    assert.ok(
        GlobalState.levelEntities.has(SCOPE),
        'a run with recorded progress must not be wiped even when nobody is standing in it'
    );
    GlobalState.levelQuestProgress.delete(SCOPE);
}

/**
 * Health corrections must reach a viewer who is drawing the enemy under an id of their own
 * that was never bound. Skipping them is an enemy dead on one screen and still standing on
 * the other; sending the canonical copy instead hands that client a second enemy.
 */
function testUnboundCopyIsBoundRatherThanSkippedOrDuplicated(): void {
    const bystander = createClient('Lanorut', 89001, 22);
    bystander.currentRoomId = 3;

    const boss = createSharedBoss();
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));
    bystander.entities.set(600031, {
        id: 600031,
        name: 'TowerGuard2',
        EntName: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        x: boss.x + 15,
        y: boss.y,
        hp: 100000,
        maxHp: 100000
    });

    const seeded: number[] = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (_viewer: Client, entity: any) => {
        seeded.push(Number(entity?.id ?? 0));
    };
    let known = false;
    try {
        known = (CombatHandler as any).ensureServerAuthorityNpcKnown(bystander, SCOPE, boss, 'test');
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.equal(known, true, 'a viewer drawing the enemy must count as knowing it');
    assert.deepEqual(seeded, [], 'binding the copy they already have must not send them a second one');
    assert.equal(
        EntityHandler.getRegisteredHostileLocalIdForViewer(bystander, boss),
        600031,
        'the copy they are drawing must end up bound to the canonical'
    );
}

function run(): void {
    ensureDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        resetState();
        testScopeIndexFollowsTheSessionThroughADoor();
        resetState();
        testEnemyDifficultyIsTheDungeonsOwn();
        resetState();
        testUnboundBossCopyStillResolvesForTheViewer();
        resetState();
        testDistantCopyIsNotAdopted();
        resetState();
        testAdoptionDoesNotDoubleBindACanonical();
        resetState();
        testServerAuthorityHostilesUseTheDungeonTier();
        resetState();
        testClosingSessionDoesNotDestroyItsSuccessorsBody();
        resetState();
        testRemoteBodyIsPlacedOnFloorNotOnTheLiveSample();
        resetState();
        testPlayerVisibilityIsExchangedBothWays();
        resetState();
        testInternalDungeonDoorDoesNotReplayThePartyAnchorPoint();
        resetState();
        testAirborneBodyWithNoFloorSampleIsNotSeeded();
        resetState();
        testVisibilityResyncSurvivesAScopeChange();
        resetState();
        testHostileHealthCorrectionsUseTheViewersOwnId();
        resetState();
        testRoomChangePushesThePlayerToEveryoneElse();
        resetState();
        testServerOwnedHostilesDropLootForTheWholeParty();
        resetState();
        testLootDropsWhereTheEnemyActuallyDied();
        resetState();
        testJoiningAPartyRunRemovesEnemiesItAlreadyKilled();
        resetState();
        testLoadingPartyMemberAnchorsTheScope();
        resetState();
        testAdoptingThePartyRunResendsItsProgress();
        resetState();
        testAlreadyDeadEnemyIsNeverShownToAJoiner();
        resetState();
        testJoiningDoesNotWipeARunInProgress();
        resetState();
        testUnboundCopyIsBoundRatherThanSkippedOrDuplicated();
        console.log('party dungeon sync regression passed');
    } finally {
        resetState();
        GlobalState.sessionsByToken = sessionsByToken;
        for (const [id, group] of partyGroups) {
            GlobalState.partyGroups.set(id, group);
        }
        for (const [name, id] of partyByMember) {
            GlobalState.partyByMember.set(name, id);
        }
        for (const [scope, map] of levelEntities) {
            GlobalState.levelEntities.set(scope, map);
        }
    }
}

run();
