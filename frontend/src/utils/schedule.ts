/**
 * 排练档期冲突判定
 * 给定某场次的候选档期，依次核对：
 * 1. 该场各影人操耍人的已排时段（撞了哪位师傅要指名道姓）；
 * 2. 班社内其他场次已排定的档期（先排上的要挡得住后来的场次）。
 */
import type { RehearsalSlot, Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator, SlotRange } from '../types/operator';
import { WEEKDAY_LABEL, minuteToClock, slotsOverlap } from '../types/operator';

/** 档期冲突描述 */
export interface ScheduleConflict {
  /** operator = 撞操耍人已排时段；scene = 撞其他场次档期 */
  kind: 'operator' | 'scene';
  /** 撞上的操耍人 id（kind = operator 时有值） */
  operatorId?: string;
  /** 撞上的操耍人姓名 */
  operatorName?: string;
  /** 撞上的场次 id（kind = scene 时有值） */
  sceneId?: string;
  /** 完整拦截文案 */
  message: string;
}

/** 档期 → 时段区间 */
export function slotToRange(slot: RehearsalSlot, slotId: string, label: string): SlotRange {
  return {
    slotId,
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    endMinute: slot.startMinute + slot.durationMinute,
    label,
  };
}

/** 档期展示文案，如「周三 14:00-15:30」 */
export function scheduleLabel(slot: RehearsalSlot): string {
  return `${WEEKDAY_LABEL[slot.weekday]} ${minuteToClock(slot.startMinute)}-${minuteToClock(
    slot.startMinute + slot.durationMinute,
  )}`;
}

/** 参演某场的操耍人（按角色指派去重） */
export function operatorsOfScene(sceneId: string, roles: ShadowRole[], operators: Operator[]): Operator[] {
  const boundIds = new Set(
    roles.filter((role) => role.sceneId === sceneId && role.operatorId !== null).map((role) => role.operatorId),
  );
  return operators.filter((operator) => boundIds.has(operator.id));
}

/** 参演某场的师傅姓名（未指派的角色记作「待指派」） */
export function participantNamesOf(sceneId: string, roles: ShadowRole[], operators: Operator[]): string[] {
  const sceneRoles = roles.filter((role) => role.sceneId === sceneId);
  const names = new Set<string>();
  sceneRoles.forEach((role) => {
    if (role.operatorId === null) {
      names.add('待指派');
      return;
    }
    names.add(operators.find((operator) => operator.id === role.operatorId)?.name ?? '（已解绑）');
  });
  return [...names];
}

/**
 * 判定候选档期能否落给某场。
 * 返回空数组表示可排；否则每一项都是一条拦截原因。
 */
export function assessSceneSchedule(
  scene: Pick<Scene, 'id' | 'seq' | 'title'>,
  slot: RehearsalSlot,
  ctx: { scenes: Scene[]; roles: ShadowRole[]; operators: Operator[] },
): ScheduleConflict[] {
  const target = slotToRange(slot, `scene-${scene.id}`, `第${scene.seq}场·${scene.title}`);
  const conflicts: ScheduleConflict[] = [];

  // 1. 本场各影人操耍人的已排时段
  const cast = operatorsOfScene(scene.id, ctx.roles, ctx.operators);
  cast.forEach((operator) => {
    operator.busySlots.forEach((busy) => {
      const range = slotToRange(
        { weekday: busy.weekday, startMinute: busy.startMinute, durationMinute: busy.durationMinute },
        busy.id,
        busy.label,
      );
      if (slotsOverlap(target, range)) {
        conflicts.push({
          kind: 'operator',
          operatorId: operator.id,
          operatorName: operator.name,
          message: `${operator.name} 师傅 ${scheduleLabel(busy)} 另有「${busy.label}」，与本场档期相撞`,
        });
      }
    });
  });

  // 2. 其他场次已排定的档期（先排上的场次要挡得住这一场）
  ctx.scenes
    .filter((other) => other.id !== scene.id && other.schedule !== null)
    .forEach((other) => {
      const otherSlot = other.schedule as RehearsalSlot;
      const range = slotToRange(otherSlot, `scene-${other.id}`, `第${other.seq}场·${other.title}`);
      if (slotsOverlap(target, range)) {
        conflicts.push({
          kind: 'scene',
          sceneId: other.id,
          message: `与已排定的「第${other.seq}场·${other.title}」（${scheduleLabel(otherSlot)}）撞场`,
        });
      }
    });

  return conflicts;
}
