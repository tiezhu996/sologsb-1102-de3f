/**
 * useSceneSchedule()
 * 排练档期冲突判定：载入全社场次与全部影人角色，
 * 当场次时长、档期或操耍人指派变动时，按最新数据重新判定一遍。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listAllRoles, listAllScenes, type RoleRow, type SceneRow } from '../utils/db';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore } from '../stores/operatorStore';
import { assessSceneSchedule, participantNamesOf, type ScheduleConflict } from '../utils/schedule';

export interface UseSceneScheduleResult {
  loading: boolean;
  /** 全社场次（跨剧目，撞场判定用） */
  allScenes: SceneRow[];
  /** 全部影人角色 */
  roles: RoleRow[];
  /** 场次 id → 当前冲突列表（含操耍人档期与撞场两类） */
  conflictsById: Map<string, ScheduleConflict[]>;
  /** 某场当前冲突 */
  conflictsOf: (sceneId: string) => ScheduleConflict[];
  /** 某场参演师傅姓名 */
  participantsOf: (sceneId: string) => string[];
  reload: () => Promise<void>;
}

export function useSceneSchedule(): UseSceneScheduleResult {
  const scenesVersion = useSceneStore((state) => state.scenes);
  const operators = useOperatorStore((state) => state.operators);
  const [allScenes, setAllScenes] = useState<SceneRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [sceneRows, roleRows] = await Promise.all([listAllScenes(), listAllRoles()]);
    setAllScenes(sceneRows);
    setRoles(roleRows);
    setLoading(false);
  }, []);

  // 场次（含时长 / 档期）变动、操耍人指派变动后都重新拉取并重判
  useEffect(() => {
    void reload();
  }, [reload, scenesVersion, operators]);

  const conflictsById = useMemo(() => {
    const map = new Map<string, ScheduleConflict[]>();
    allScenes.forEach((scene) => {
      if (scene.schedule === null) return;
      const conflicts = assessSceneSchedule(
        scene,
        scene.schedule,
        { scenes: allScenes, roles, operators },
      );
      if (conflicts.length > 0) map.set(scene.id, conflicts);
    });
    return map;
  }, [allScenes, roles, operators]);

  const conflictsOf = useCallback(
    (sceneId: string) => conflictsById.get(sceneId) ?? [],
    [conflictsById],
  );

  const participantsOf = useCallback(
    (sceneId: string) => participantNamesOf(sceneId, roles, operators),
    [roles, operators],
  );

  return { loading, allScenes, roles, conflictsById, conflictsOf, participantsOf, reload };
}
