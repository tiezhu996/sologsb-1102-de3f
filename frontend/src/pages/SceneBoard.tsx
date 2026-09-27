/**
 * /plays/:id/scenes 场次拆分与调序
 * 左列场序（拖拽调序 + 勾选本次排练覆盖），右侧场次明细；消费 Scene、Play，复用 <SceneCard>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  App,
  Alert,
  Button,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  CheckSquareOutlined,
  CopyOutlined,
  PlusOutlined,
  SaveOutlined,
  SoundOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { SceneCard } from '../components/common/SceneCard';
import { EmptyState } from '../components/common/EmptyState';
import { useSceneOrder } from '../hooks/useSceneOrder';
import { useSceneSchedule } from '../hooks/useSceneSchedule';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import {
  SHADOW_SCREEN_LABEL,
  SHADOW_SCREEN_OPTIONS,
  type RehearsalSlot,
  type SceneDraft,
  createEmptySceneDraft,
} from '../types/scene';
import { DAY_BASE_HOUR, WEEKDAY_OPTIONS, type Weekday } from '../types/operator';
import { assessSceneSchedule, scheduleLabel, type ScheduleConflict } from '../utils/schedule';
import { buildCallSheetText, copyText, exportPlayCsvFile } from '../utils/export';
import { listCuesByScenes, listRolesByScenes, type SceneRow } from '../utils/db';
import { minutesToReadable } from '../utils/timecode';
import { formatStamp } from '../utils/uuid';

/** TimePicker 值 → 相对当日 08:00 的分钟偏移 */
function clockToMinute(value: dayjs.Dayjs): number {
  return value.hour() * 60 + value.minute() - DAY_BASE_HOUR * 60;
}

/** 分钟偏移 → TimePicker 值 */
function minuteToDayjs(minute: number): dayjs.Dayjs {
  const total = DAY_BASE_HOUR * 60 + minute;
  return dayjs().hour(Math.floor(total / 60)).minute(total % 60).second(0);
}

export default function SceneBoard() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<SceneDraft>();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const syncSceneCount = usePlayStore((state) => state.syncSceneCount);
  const statOf = usePlayStore((state) => state.statOf);

  const {
    items,
    scenes,
    selectedSceneIds,
    selectedMinute,
    totalMinute,
    totalReadable,
    loading,
    reorder,
    adjacentMinute,
    toggleSelected,
    selectAll,
    clearSelected,
  } = useSceneOrder(playId);

  const createSceneFromPrevious = useSceneStore((state) => state.createSceneFromPrevious);
  const updateScene = useSceneStore((state) => state.updateScene);
  const deleteScene = useSceneStore((state) => state.deleteScene);
  const bumpProgress = useSceneStore((state) => state.bumpProgress);
  const onlySelected = useSceneStore((state) => state.onlySelected);
  const setOnlySelected = useSceneStore((state) => state.setOnlySelected);

  const operators = useOperatorStore((state) => state.operators);

  const scheduleBoard = useSceneSchedule();

  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const play = plays.find((item) => item.id === playId) ?? null;
  const playStat = statOf(playId);

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  useEffect(() => {
    if (scenes.length > 0 && (activeSceneId === null || !scenes.some((scene) => scene.id === activeSceneId))) {
      setActiveSceneId(scenes[0].id);
    }
    if (scenes.length === 0) setActiveSceneId(null);
  }, [scenes, activeSceneId]);

  useEffect(() => {
    if (playId && !loading) void syncSceneCount(playId);
  }, [playId, loading, syncSceneCount]);

  const activeItem = useMemo(() => items.find((item) => item.scene.id === activeSceneId) ?? null, [items, activeSceneId]);
  const visibleItems = onlySelected ? items.filter((item) => selectedSceneIds.includes(item.scene.id)) : items;

  const handleReorder = async (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const ids = items.map((item) => item.scene.id);
    const fromIndex = ids.indexOf(draggingId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, draggingId);
    await reorder(next);
    message.success('场序已调整');
  };

  const handleCreate = async () => {
    const values = await form.validateFields();
    const last = scenes.length > 0 ? scenes[scenes.length - 1] : undefined;
    const created = await createSceneFromPrevious(playId, last);
    await updateScene(created.id, {
      title: values.title.trim() || created.title,
      durationMin: values.durationMin,
      stageNote: values.stageNote ?? '',
      needsShadowScreen: values.needsShadowScreen,
      progress: values.progress ?? 0,
    });
    setCreateOpen(false);
    setActiveSceneId(created.id);
    message.success(`已新增「${values.title.trim() || created.title}」`);
  };

  /** 打开新增弹窗：先落一次初始值，避免弹窗内残留上一次的输入 */
  const openCreate = () => {
    form.setFieldsValue(createEmptySceneDraft(scenes.length + 1));
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    form.resetFields();
  };

  const confirmDelete = (sceneId: string, title: string) => {
    modal.confirm({
      title: `删除「${title}」？`,
      content: '该场次下的影人角色与锣鼓点会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteScene(sceneId);
        message.success('场次已删除，场序已重排');
      },
    });
  };

  /** 导出本剧排练通告（含场次、星期时段、参演师傅） */
  const handleExportCsv = async () => {
    const [roleRows, cueRows] = await Promise.all([
      listRolesByScenes(scenes.map((scene) => scene.id)),
      listCuesByScenes(scenes.map((scene) => scene.id)),
    ]);
    if (!play) return;
    const filename = exportPlayCsvFile(play, scenes, roleRows, cueRows, operators);
    message.success(`已导出排练通告：${filename}`);
  };

  const handleCopyCallSheet = async () => {
    if (!play) return;
    const roleRows = await listRolesByScenes(scenes.map((scene) => scene.id));
    const text = buildCallSheetText(play, scenes, roleRows, operators);
    const ok = await copyText(text);
    if (ok) message.success('排练通告已复制，可粘贴到班社群里');
    else message.warning('浏览器未开放剪贴板，请改用 CSV 导出');
  };

  /** 场次行的档期标签：已排 / 冲突 / 未排 */
  const renderScheduleTag = (scene: SceneRow) => {
    if (scene.schedule === null) {
      return (
        <Tag icon={<CalendarOutlined />}>
          未排档期
        </Tag>
      );
    }
    const conflicts = scheduleBoard.conflictsOf(scene.id);
    return (
      <Tooltip title={conflicts.length > 0 ? conflicts.map((item) => item.message).join('；') : '档期无冲突'}>
        <Tag color={conflicts.length > 0 ? 'red' : 'green'} icon={<CalendarOutlined />}>
          {scheduleLabel(scene.schedule)}
          {conflicts.length > 0 ? '·撞' : ''}
        </Tag>
      </Tooltip>
    );
  };

  if (!play) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该剧目"
          description="剧目可能已被删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plays)}>
              剧目库
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              场次拆分 · {play.title}
            </Typography.Title>
            <Tag color="gold">共 {scenes.length} 场 / 建档 {play.totalScenes} 场</Tag>
            <Tag>合计 {totalReadable}</Tag>
          </Space>
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={openCreate}>
              新增场次
            </Button>
            <Button
              icon={<TeamOutlined />}
              disabled={!activeSceneId}
              onClick={() => activeSceneId && navigate(ROUTES.roles(activeSceneId))}
            >
              角色指派
            </Button>
            <Button
              icon={<SoundOutlined />}
              disabled={!activeSceneId}
              onClick={() => activeSceneId && navigate(ROUTES.cues(activeSceneId))}
            >
              锣鼓点
            </Button>
            <Tooltip title="导出 CSV：场次、星期时段与参演师傅">
              <Button disabled={scenes.length === 0} onClick={() => void handleExportCsv()}>
                导出通告
              </Button>
            </Tooltip>
            <Tooltip title="复制纯文本排练通告">
              <Button icon={<CopyOutlined />} disabled={scenes.length === 0} onClick={() => void handleCopyCallSheet()}>
                复制通告
              </Button>
            </Tooltip>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="整剧合计时长" value={totalMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="本次排练勾选" value={selectedSceneIds.length} suffix={`/ ${scenes.length} 场`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="勾选场次合计" value={selectedMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="平均排练成熟度" value={playStat.averageProgress} suffix="%" />
          </Col>
        </Row>

        <Divider style={{ margin: '14px 0 10px' }} />
        <Space wrap size={10}>
          <Checkbox checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)}>
            只看本次勾选
          </Checkbox>
          <Button size="small" icon={<CheckSquareOutlined />} onClick={selectAll}>
            全选本次排练
          </Button>
          <Button size="small" onClick={clearSelected}>
            清空勾选
          </Button>
          <Typography.Text type="secondary">
            相邻两场合计参考：
            {items.length > 1
              ? `第1+2场 ${minutesToReadable(adjacentMinute(0))}、第2+3场 ${
                  items.length > 2 ? minutesToReadable(adjacentMinute(1)) : '—'
                }`
              : '—'}
          </Typography.Text>
        </Space>
      </div>

      {scenes.length === 0 ? (
        <div className="gb-panel">
          <EmptyState
            title="这出戏还没有场次"
            description="把剧目拆成场次后，才能为每场指派影人操耍人与锣鼓点。"
            actionText="新增第一场"
            onAction={openCreate}
          />
        </div>
      ) : (
        <Row gutter={16}>
          <Col xs={24} lg={13}>
            <div className="gb-panel">
              <div className="gb-panel-title">
                <Typography.Text strong>场序表（拖动手柄可调序）</Typography.Text>
                <Space size={8}>
                  <Tag>{visibleItems.length} 场可见</Tag>
                  <Tag color="gold">勾选 {selectedSceneIds.length} 场</Tag>
                </Space>
              </div>
              <div className="gb-scene-list">
                {visibleItems.length === 0 ? (
                  <EmptyState
                    size="small"
                    title="勾选为空"
                    description="已开启「只看本次勾选」，请先在场序表中勾选本次排练覆盖的场次。"
                    actionText="显示全部场次"
                    onAction={() => setOnlySelected(false)}
                  />
                ) : (
                  visibleItems.map((item, index) => (
                    <div
                      key={item.scene.id}
                      className={`gb-scene-row ${dropTargetId === item.scene.id ? 'is-drop-target' : ''}`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDropTargetId(item.scene.id);
                      }}
                      onDragLeave={() => setDropTargetId((prev) => (prev === item.scene.id ? null : prev))}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDropTargetId(null);
                        void handleReorder(item.scene.id);
                      }}
                    >
                      <TinyOrderIndex index={index} total={visibleItems.length} />
                      <div style={{ flex: 1 }}>
                        <SceneCard
                          scene={item.scene}
                          startTimecode={item.startTimecode}
                          endTimecode={item.endTimecode}
                          roleCount={0}
                          cueCount={0}
                          selected={selectedSceneIds.includes(item.scene.id)}
                          selectable
                          draggable
                          dragging={draggingId === item.scene.id}
                          onToggleSelect={() => toggleSelected(item.scene.id)}
                          onOpen={() => setActiveSceneId(item.scene.id)}
                          onEdit={() => setActiveSceneId(item.scene.id)}
                          onDelete={() => confirmDelete(item.scene.id, item.scene.title)}
                          onDragStart={() => setDraggingId(item.scene.id)}
                          onDragEnd={() => {
                            setDraggingId(null);
                            setDropTargetId(null);
                          }}
                          onDrop={() => {
                            void handleReorder(item.scene.id);
                          }}
                          extraActions={
                            <Tag color={selectedSceneIds.includes(item.scene.id) ? '#7a1f1f' : 'default'}>
                              {selectedSceneIds.includes(item.scene.id) ? '本次排练' : '本次跳过'}
                            </Tag>
                          }
                          scheduleTag={renderScheduleTag(item.scene)}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Col>

          <Col xs={24} lg={11}>
            <div className="gb-panel">
              {activeItem ? (
                <SceneDetailPanel
                  key={activeItem.scene.id}
                  sceneId={activeItem.scene.id}
                  startTimecode={activeItem.startTimecode}
                  accumulatedMinute={activeItem.accumulatedMinute}
                  operatorCount={operators.length}
                  participants={scheduleBoard.participantsOf(activeItem.scene.id)}
                  liveConflicts={scheduleBoard.conflictsOf(activeItem.scene.id)}
                  assessSlot={(slot) =>
                    assessSceneSchedule(activeItem.scene, slot, {
                      scenes: scheduleBoard.allScenes,
                      roles: scheduleBoard.roles,
                      operators,
                    })
                  }
                  onSave={updateScene}
                  onProgress={(delta) => void bumpProgress(activeItem.scene.id, delta)}
                  onDelete={() => confirmDelete(activeItem.scene.id, activeItem.scene.title)}
                  onRoles={() => navigate(ROUTES.roles(activeItem.scene.id))}
                  onCues={() => navigate(ROUTES.cues(activeItem.scene.id))}
                />
              ) : (
                <EmptyState
                  size="small"
                  title="请选择左侧场次"
                  description="选中场次后可编辑舞台提示、影窗规格与排练进度。"
                />
              )}
            </div>
          </Col>
        </Row>
      )}

      <Modal
        open={createOpen}
        title={`新增场次（当前共 ${scenes.length} 场）`}
        okText="新增"
        cancelText="取消"
        onCancel={closeCreate}
        onOk={() => void handleCreate()}
      >
        <Form form={form} layout="vertical" initialValues={createEmptySceneDraft(scenes.length + 1)}>
          <Form.Item name="title" label="场次标题" rules={[{ required: true, message: '请填写场次标题' }]}>
            <Input placeholder="如：第四场·断桥" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="durationMin" label="时长（分钟）" rules={[{ required: true, message: '请填写时长' }]}>
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="needsShadowScreen" label="影窗规格" rules={[{ required: true, message: '请选择影窗规格' }]}>
                <Select options={[...SHADOW_SCREEN_OPTIONS]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="stageNote" label="舞台提示">
            <Input.TextArea rows={3} placeholder="影件更换、走位、灯暗留白等提示" />
          </Form.Item>
          <Form.Item name="progress" label="初始排练进度（%）">
            <Slider min={0} max={100} step={5} marks={{ 0: '0', 50: '50', 100: '100' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 左侧列表的场序角标 */
function TinyOrderIndex({ index, total }: { index: number; total: number }) {
  return (
    <div style={{ width: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#7a1f1f', lineHeight: 1.1 }}>{index + 1}</div>
      <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>/ {total}</div>
    </div>
  );
}

interface SceneDetailPanelProps {
  sceneId: string;
  startTimecode: string;
  accumulatedMinute: number;
  operatorCount: number;
  /** 本场参演师傅姓名（含「待指派」） */
  participants: string[];
  /** 已排档期的实时冲突（时长 / 操耍人变动后重判的结果） */
  liveConflicts: ScheduleConflict[];
  /** 保存前试算候选档期，返回冲突列表（空 = 可排） */
  assessSlot: (slot: RehearsalSlot) => ScheduleConflict[];
  onSave: (
    sceneId: string,
    patch: Partial<Omit<SceneRow, 'id' | 'playId' | 'createdAt' | 'revision'>>,
  ) => Promise<void>;
  onProgress: (delta: number) => void;
  onDelete: () => void;
  onRoles: () => void;
  onCues: () => void;
}

function SceneDetailPanel({
  sceneId,
  startTimecode,
  accumulatedMinute,
  operatorCount,
  participants,
  liveConflicts,
  assessSlot,
  onSave,
  onProgress,
  onDelete,
  onRoles,
  onCues,
}: SceneDetailPanelProps) {
  const { message, modal } = App.useApp();
  const scene = useSceneStore((state) => state.scenes.find((item) => item.id === sceneId) ?? null);
  const [title, setTitle] = useState(scene?.title ?? '');
  const [durationMin, setDurationMin] = useState(scene?.durationMin ?? 12);
  const [stageNote, setStageNote] = useState(scene?.stageNote ?? '');
  const [screen, setScreen] = useState(scene?.needsShadowScreen ?? 'standard');
  const [saving, setSaving] = useState(false);
  const [savingSlot, setSavingSlot] = useState(false);
  const [slotWeekday, setSlotWeekday] = useState<Weekday>(scene?.schedule?.weekday ?? 1);
  const [slotStart, setSlotStart] = useState<dayjs.Dayjs>(() =>
    minuteToDayjs(scene?.schedule?.startMinute ?? 60),
  );
  const [slotDuration, setSlotDuration] = useState<number>(
    scene?.schedule?.durationMinute ?? scene?.durationMin ?? 12,
  );

  // 已排档期在外部变化（清除 / 重判后）时，编辑器跟随回填
  useEffect(() => {
    if (scene?.schedule) {
      setSlotWeekday(scene.schedule.weekday);
      setSlotStart(minuteToDayjs(scene.schedule.startMinute));
      setSlotDuration(scene.schedule.durationMinute);
    }
  }, [scene?.schedule]);

  if (!scene) return null;

  const dirty =
    title !== scene.title ||
    durationMin !== scene.durationMin ||
    stageNote !== scene.stageNote ||
    screen !== scene.needsShadowScreen;

  const save = async () => {
    setSaving(true);
    const nextDuration = Math.max(1, Math.round(durationMin));
    await onSave(sceneId, {
      title: title.trim() || scene.title,
      durationMin: nextDuration,
      stageNote: stageNote.trim(),
      needsShadowScreen: screen,
    });
    setSaving(false);
    // 场次时长变了以后重判一遍已排档期
    if (scene.schedule && nextDuration !== scene.durationMin) {
      const conflicts = assessSlot(scene.schedule);
      if (conflicts.length > 0) {
        modal.warning({
          title: '场次时长已改，原排练档期现在撞期了',
          content: (
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {conflicts.map((item, index) => (
                <li key={index}>{item.message}</li>
              ))}
            </ul>
          ),
          okText: '知道了，去重排',
        });
      }
    }
    message.success('场次明细已保存');
  };

  /** 保存排练档期：先查各影人操耍人的档期，再查别场撞场，撞了就搁下 */
  const saveSchedule = async () => {
    const startMinute = clockToMinute(slotStart);
    if (startMinute < 0) {
      message.warning('排练开始时间请排在 08:00 之后');
      return;
    }
    const slot: RehearsalSlot = {
      weekday: slotWeekday,
      startMinute,
      durationMinute: Math.max(1, Math.round(slotDuration)),
    };
    const conflicts = assessSlot(slot);
    if (conflicts.length > 0) {
      const operatorNames = [...new Set(conflicts.filter((item) => item.operatorName).map((item) => item.operatorName))];
      modal.warning({
        title: '这个档期排不上，先搁下了',
        content: (
          <div>
            {operatorNames.length > 0 ? <p>撞到了：{operatorNames.join('、')} 师傅。</p> : null}
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {conflicts.map((item, index) => (
                <li key={index}>{item.message}</li>
              ))}
            </ul>
          </div>
        ),
        okText: '知道了',
      });
      return;
    }
    setSavingSlot(true);
    await onSave(sceneId, { schedule: slot });
    setSavingSlot(false);
    message.success(`排练档期已排定：${scheduleLabel(slot)}`);
  };

  const clearSchedule = async () => {
    setSavingSlot(true);
    await onSave(sceneId, { schedule: null });
    setSavingSlot(false);
    message.success('已撤下本场排练档期');
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Text strong>
          第 {scene.seq} 场明细（开场 {startTimecode}｜累计 {minutesToReadable(accumulatedMinute)}）
        </Typography.Text>
        <Tag>更新于 {formatStamp(scene.updatedAt)}</Tag>
      </Space>

      <div>
        <Typography.Text type="secondary">场次标题</Typography.Text>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={40} />
      </div>

      <Row gutter={12}>
        <Col span={12}>
          <Typography.Text type="secondary">时长（分钟）</Typography.Text>
          <InputNumber
            min={1}
            max={180}
            style={{ width: '100%' }}
            value={durationMin}
            onChange={(value) => setDurationMin(typeof value === 'number' ? value : 12)}
          />
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">影窗规格</Typography.Text>
          <Select
            style={{ width: '100%' }}
            value={screen}
            onChange={(value) => setScreen(value)}
            options={[...SHADOW_SCREEN_OPTIONS]}
          />
        </Col>
      </Row>

      <div>
        <Typography.Text type="secondary">舞台提示</Typography.Text>
        <Input.TextArea
          rows={4}
          value={stageNote}
          maxLength={200}
          showCount
          onChange={(event) => setStageNote(event.target.value)}
        />
      </div>

      <Divider style={{ margin: '4px 0' }}>排练档期</Divider>

      {scene.schedule ? (
        <Space size={6} wrap>
          <Typography.Text type="secondary">已排：</Typography.Text>
          <Tag color={liveConflicts.length > 0 ? 'red' : 'green'} icon={<CalendarOutlined />}>
            {scheduleLabel(scene.schedule)}（{minutesToReadable(scene.schedule.durationMinute)}）
          </Tag>
          {liveConflicts.length > 0 ? <Tag color="red">撞期 {liveConflicts.length} 处</Tag> : <Tag>无冲突</Tag>}
        </Space>
      ) : (
        <Typography.Text type="secondary">本场还没排档期，选好星期与时间后保存。</Typography.Text>
      )}

      {scene.schedule && liveConflicts.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message="已排的档期现在撞期了，请重排"
          description={
            <Space direction="vertical" size={2}>
              {liveConflicts.map((item, index) => (
                <Typography.Text key={index} type="danger" style={{ fontSize: 12 }}>
                  {item.message}
                </Typography.Text>
              ))}
            </Space>
          }
        />
      ) : null}

      <Row gutter={12}>
        <Col span={8}>
          <Typography.Text type="secondary">星期</Typography.Text>
          <Select<Weekday>
            style={{ width: '100%' }}
            value={slotWeekday}
            onChange={(value) => setSlotWeekday(value)}
            options={[...WEEKDAY_OPTIONS]}
          />
        </Col>
        <Col span={8}>
          <Typography.Text type="secondary">起始时间</Typography.Text>
          <TimePicker
            style={{ width: '100%' }}
            format="HH:mm"
            minuteStep={15}
            value={slotStart}
            onChange={(value) => value && setSlotStart(value)}
            allowClear={false}
          />
        </Col>
        <Col span={8}>
          <Typography.Text type="secondary">时长（分钟）</Typography.Text>
          <InputNumber
            min={15}
            max={480}
            step={15}
            style={{ width: '100%' }}
            value={slotDuration}
            onChange={(value) => setSlotDuration(typeof value === 'number' ? value : scene.durationMin)}
          />
        </Col>
      </Row>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        参演师傅：{participants.length > 0 ? participants.join('、') : '尚未指派操耍人'}；保存前会先核对这些师傅的已排时段，再挡住别场撞场。
      </Typography.Text>

      <Space wrap>
        <Button
          type="primary"
          ghost
          icon={<CalendarOutlined />}
          loading={savingSlot}
          onClick={() => void saveSchedule()}
        >
          {scene.schedule ? '重排档期' : '保存档期'}
        </Button>
        {scene.schedule ? (
          <Button loading={savingSlot} onClick={() => void clearSchedule()}>
            撤下档期
          </Button>
        ) : null}
      </Space>

      <Divider style={{ margin: '4px 0' }} />

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Text type="secondary">排练进度</Typography.Text>
          <Space size={4}>
            <Button size="small" onClick={() => onProgress(-10)}>
              -10%
            </Button>
            <Button size="small" type="primary" ghost onClick={() => onProgress(10)}>
              +10%
            </Button>
            <Button size="small" onClick={() => void onSave(sceneId, { progress: 100 })}>
              标记可上演
            </Button>
          </Space>
        </Space>
        <Progress percent={scene.progress} strokeColor="#7a1f1f" />
      </div>

      <Space wrap>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={() => void save()}>
          保存明细
        </Button>
        <Button icon={<TeamOutlined />} onClick={onRoles}>
          指派影人（操耍人档 {operatorCount} 人）
        </Button>
        <Button icon={<SoundOutlined />} onClick={onCues}>
          编排锣鼓点
        </Button>
        <Button danger onClick={onDelete}>
          删除本场
        </Button>
      </Space>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        当前影窗：{SHADOW_SCREEN_LABEL[scene.needsShadowScreen]}；修改场序请拖动左侧手柄，场序会自动重排并落库。
      </Typography.Text>
    </Space>
  );
}
