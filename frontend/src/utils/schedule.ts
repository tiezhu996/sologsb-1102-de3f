/**
 * 排练档期判定（纯函数，不碰存储）
 * - 保存前预检：候选时段 vs 本场各影人操耍人的已排时段
 * - 跨场次挡期：候选时段 vs 其他场次已排定的排练档期（含其他剧目）
 * - 已排档期的状态重判：场次时长 / 操耍人 / 他人档期变化后重新求值
 */
import type { RehearsalSlot } from '../types/scene';
import type { Operator, SlotRange, Weekday } from '../types/operator';
import type { ShadowRole } from '../types/role';
import { WEEKDAY_LABEL, minuteToClock, slotsOverlap } from '../types/operator';

/** 判定所需的最小场次信息 */
export interface ScheduleSceneLike {
  id: string;
  playId: string;
  seq: number;
  title: string;
  durationMin: number;
  rehearsalSlot: RehearsalSlot | null;
}

/** 判定所需的最小剧目信息（用于撞期文案） */
export interface SchedulePlayLike {
  id: string;
  title: string;
}

/** 一处撞期：要么撞上某位操耍人，要么撞上别场排练（该场可能尚未指派操耍人） */
export interface ScheduleConflict {
  kind: 'operator' | 'scene';
  /** 撞了哪位师傅；对方场次未指派操耍人时为 null */
  operatorName: string | null;
  /** 该师傅在相关场次操耍的影人角色 */
  roleNames: string[];
  /** 完整描述，如「周一 08:00-11:00 已排「连排《借伞》」」 */
  describe: string;
}

export interface ScheduleEvaluation {
  /** 参与判定的候选时段（时长以入参 slot 为准） */
  slot: RehearsalSlot;
  conflicts: ScheduleConflict[];
  ok: boolean;
}

/** 档期 → 「周三 14:00-15:30」 */
export function slotText(slot: RehearsalSlot): string {
  return `${WEEKDAY_LABEL[slot.weekday]} ${minuteToClock(slot.startMinute)}-${minuteToClock(
    slot.startMinute + slot.durationMinute,
  )}`;
}

function toRange(slot: RehearsalSlot, slotId: string, label: string): SlotRange {
  return {
    slotId,
    weekday: slot.weekday,
    startMinute: slot.startMinute,
    endMinute: slot.startMinute + slot.durationMinute,
    label,
  };
}

function overlapText(weekday: Weekday, a: SlotRange, b: SlotRange): string {
  const from = minuteToClock(Math.max(a.startMinute, b.startMinute));
  const to = minuteToClock(Math.min(a.endMinute, b.endMinute));
  return `${WEEKDAY_LABEL[weekday]} ${from}-${to}`;
}

/** 某场次里各操耍人及其操耍的影人角色（按操耍人去重，角色名归并） */
function operatorsOfScene(
  sceneId: string,
  roles: ShadowRole[],
  operators: Operator[],
): Array<{ operator: Operator; roleNames: string[] }> {
  const byOperator = new Map<string, { operator: Operator; roleNames: string[] }>();
  roles
    .filter((role) => role.sceneId === sceneId && role.operatorId !== null)
    .forEach((role) => {
      const operator = operators.find((item) => item.id === role.operatorId);
      if (!operator) return;
      const entry = byOperator.get(operator.id) ?? { operator, roleNames: [] };
      if (!entry.roleNames.includes(role.name)) entry.roleNames.push(role.name);
      byOperator.set(operator.id, entry);
    });
  return [...byOperator.values()];
}

/**
 * 评估「scene 排在 slot」会撞上谁。
 * allScenes 需包含全部剧目场次（跨剧目同样挡期），自身会被跳过。
 */
export function evaluateRehearsalSlot(args: {
  scene: ScheduleSceneLike;
  slot: RehearsalSlot;
  allScenes: ScheduleSceneLike[];
  operators: Operator[];
  roles: ShadowRole[];
  plays: SchedulePlayLike[];
}): ScheduleEvaluation {
  const { scene, slot, allScenes, operators, roles, plays } = args;
  const conflicts: ScheduleConflict[] = [];
  const candidate = toRange(slot, scene.id, scene.title);

  // 1) 本场各影人操耍人的已排时段
  operatorsOfScene(scene.id, roles, operators).forEach(({ operator, roleNames }) => {
    operator.busySlots.forEach((busy) => {
      const busyRange = toRange(
        { weekday: busy.weekday, startMinute: busy.startMinute, durationMinute: busy.durationMinute },
        busy.id,
        busy.label,
      );
      if (!slotsOverlap(candidate, busyRange)) return;
      conflicts.push({
        kind: 'operator',
        operatorName: operator.name,
        roleNames,
        describe: `${overlapText(busy.weekday, candidate, busyRange)} 撞上「${busy.label}」`,
      });
    });
  });

  // 2) 其他场次已排定的排练档期（含其他剧目）
  allScenes
    .filter((other) => other.id !== scene.id && other.rehearsalSlot !== null)
    .forEach((other) => {
      const otherSlot = other.rehearsalSlot as RehearsalSlot;
      const otherRange = toRange(otherSlot, other.id, other.title);
      if (!slotsOverlap(candidate, otherRange)) return;
      const playTitle = plays.find((play) => play.id === other.playId)?.title ?? '';
      const where = `${playTitle ? `《${playTitle}》` : ''}第 ${other.seq} 场·${other.title}`;
      const when = overlapText(otherSlot.weekday, candidate, otherRange);
      const holders = operatorsOfScene(other.id, roles, operators);
      if (holders.length === 0) {
        conflicts.push({
          kind: 'scene',
          operatorName: null,
          roleNames: [],
          describe: `${when} 与${where}的排练撞期（该场尚未指派操耍人）`,
        });
        return;
      }
      holders.forEach(({ operator, roleNames }) => {
        conflicts.push({
          kind: 'scene',
          operatorName: operator.name,
          roleNames,
          describe: `${when} 与${where}的排练撞期`,
        });
      });
    });

  return { slot, conflicts, ok: conflicts.length === 0 };
}

/** 撞期涉及的师傅名单（去重，不含未指派的场次撞期） */
export function conflictOperatorNames(conflicts: ScheduleConflict[]): string[] {
  const names = conflicts
    .map((conflict) => conflict.operatorName)
    .filter((name): name is string => name !== null);
  return [...new Set(names)];
}

/** 已排档期的展示状态 */
export type SlotState = 'unscheduled' | 'ok' | 'blocked';

export interface SlotStatus {
  state: SlotState;
  conflicts: ScheduleConflict[];
}

/** 由判定结果折算展示状态 */
export function slotStatusOf(slot: RehearsalSlot | null, conflicts: ScheduleConflict[]): SlotStatus {
  if (slot === null) return { state: 'unscheduled', conflicts: [] };
  return { state: conflicts.length > 0 ? 'blocked' : 'ok', conflicts };
}
