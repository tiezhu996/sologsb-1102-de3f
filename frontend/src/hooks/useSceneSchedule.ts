/**
 * useSceneSchedule(playId)
 * 场次排练档期的排定、取消与状态重判；被场次页消费。
 * 判定输入（场次 / 影人角色 / 操耍人）任一变化，已排档期的撞期状态随之重算。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOperatorStore } from '../stores/operatorStore';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { db, listAllRoles, type RoleRow, type SceneRow } from '../utils/db';
import {
  evaluateRehearsalSlot,
  slotStatusOf,
  type ScheduleConflict,
  type SlotStatus,
} from '../utils/schedule';
import type { RehearsalSlot } from '../types/scene';

export interface SlotSaveResult {
  ok: boolean;
  conflicts: ScheduleConflict[];
}

export interface UseSceneScheduleResult {
  loading: boolean;
  /** 已排定档期的场次数（全剧目） */
  scheduledCount: number;
  /** 当前剧目里撞期的场次数 */
  blockedCount: number;
  /** 某场次已排档期的实时状态（未排定 / 可排 / 撞期） */
  statusOf: (sceneId: string) => SlotStatus;
  /** 某场次的参演操耍人及其操耍的影人角色 */
  castOf: (sceneId: string) => Array<{ operatorName: string; roleNames: string[] }>;
  /** 预检候选时段（不落库），供排期弹窗实时提示 */
  preview: (sceneId: string, slot: RehearsalSlot) => ScheduleConflict[];
  /** 排定档期：先预检，撞期则不落库并返回冲突明细 */
  save: (sceneId: string, slot: RehearsalSlot) => Promise<SlotSaveResult>;
  /** 取消档期 */
  clear: (sceneId: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useSceneSchedule(playId: string): UseSceneScheduleResult {
  const operators = useOperatorStore((state) => state.operators);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const plays = usePlayStore((state) => state.plays);
  const playScenes = useSceneStore((state) => state.scenes);
  const updateScene = useSceneStore((state) => state.updateScene);

  const [allScenes, setAllScenes] = useState<SceneRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [sceneRows, roleRows] = await Promise.all([db.scenes.toArray(), listAllRoles()]);
    setAllScenes(sceneRows);
    setRoles(roleRows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadOperators();
    void reload();
  }, [loadOperators, reload]);

  // 本剧场次有增删改（含时长联动档期）时，重拉全量场次保持跨场次判定新鲜
  useEffect(() => {
    if (!loading) void reload();
  }, [playScenes, loading, reload]);

  /** 全部已排档期的实时判定结果：操耍人 / 角色 / 场次一变即重算 */
  const statusMap = useMemo(() => {
    const map = new Map<string, SlotStatus>();
    allScenes.forEach((scene) => {
      if (scene.rehearsalSlot === null) return;
      const evaluation = evaluateRehearsalSlot({
        scene,
        slot: scene.rehearsalSlot,
        allScenes,
        operators,
        roles,
        plays,
      });
      map.set(scene.id, slotStatusOf(scene.rehearsalSlot, evaluation.conflicts));
    });
    return map;
  }, [allScenes, operators, roles, plays]);

  const statusOf = useCallback(
    (sceneId: string): SlotStatus => statusMap.get(sceneId) ?? { state: 'unscheduled', conflicts: [] },
    [statusMap],
  );

  const castOf = useCallback(
    (sceneId: string): Array<{ operatorName: string; roleNames: string[] }> => {
      const byOperator = new Map<string, { operatorName: string; roleNames: string[] }>();
      roles
        .filter((role) => role.sceneId === sceneId && role.operatorId !== null)
        .forEach((role) => {
          const operator = operators.find((item) => item.id === role.operatorId);
          if (!operator) return;
          const entry = byOperator.get(operator.id) ?? { operatorName: operator.name, roleNames: [] };
          if (!entry.roleNames.includes(role.name)) entry.roleNames.push(role.name);
          byOperator.set(operator.id, entry);
        });
      return [...byOperator.values()];
    },
    [operators, roles],
  );

  const preview = useCallback(
    (sceneId: string, slot: RehearsalSlot): ScheduleConflict[] => {
      const scene = allScenes.find((item) => item.id === sceneId);
      if (!scene) return [];
      return evaluateRehearsalSlot({ scene, slot, allScenes, operators, roles, plays }).conflicts;
    },
    [allScenes, operators, roles, plays],
  );

  const save = useCallback(
    async (sceneId: string, slot: RehearsalSlot): Promise<SlotSaveResult> => {
      const conflicts = preview(sceneId, slot);
      if (conflicts.length > 0) return { ok: false, conflicts };
      await updateScene(sceneId, { rehearsalSlot: slot });
      await reload();
      return { ok: true, conflicts: [] };
    },
    [preview, reload, updateScene],
  );

  const clear = useCallback(
    async (sceneId: string): Promise<void> => {
      await updateScene(sceneId, { rehearsalSlot: null });
      await reload();
    },
    [reload, updateScene],
  );

  const scheduledCount = useMemo(() => allScenes.filter((scene) => scene.rehearsalSlot !== null).length, [allScenes]);

  const blockedCount = useMemo(
    () =>
      allScenes.filter(
        (scene) => scene.playId === playId && (statusMap.get(scene.id)?.state ?? 'unscheduled') === 'blocked',
      ).length,
    [allScenes, playId, statusMap],
  );

  return { loading, scheduledCount, blockedCount, statusOf, castOf, preview, save, clear, reload };
}
