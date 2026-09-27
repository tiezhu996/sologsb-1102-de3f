/**
 * /plays/:id/scenes 场次拆分与调序
 * 左列场序（拖拽调序 + 勾选本次排练覆盖），右侧场次明细；消费 Scene、Play，复用 <SceneCard>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
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
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  CheckSquareOutlined,
  CopyOutlined,
  DownloadOutlined,
  PlusOutlined,
  SaveOutlined,
  SoundOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { SceneCard } from '../components/common/SceneCard';
import { EmptyState } from '../components/common/EmptyState';
import { SceneScheduleModal } from '../components/SceneScheduleModal';
import { useSceneOrder } from '../hooks/useSceneOrder';
import { useSceneSchedule } from '../hooks/useSceneSchedule';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import { SHADOW_SCREEN_LABEL, SHADOW_SCREEN_OPTIONS, type SceneDraft, createEmptySceneDraft } from '../types/scene';
import { slotText, type SlotStatus } from '../utils/schedule';
import { listCuesByScenes, listRolesByScenes } from '../utils/db';
import { buildCallSheetText, copyText, exportPlayCsvFile } from '../utils/export';
import { minutesToReadable } from '../utils/timecode';
import { formatStamp } from '../utils/uuid';
import type { SceneRow } from '../utils/db';

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

  const schedule = useSceneSchedule(playId);

  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

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

  /** 场序表卡片上的档期标签：排定且干净为绿色，撞期为红色 */
  const renderScheduleTag = (scene: SceneRow) => {
    const slot = scene.rehearsalSlot;
    if (!slot) return <Tag>未排档期</Tag>;
    const status = schedule.statusOf(scene.id);
    const blocked = status.state === 'blocked';
    return (
      <Tooltip
        title={
          blocked
            ? status.conflicts
                .map((conflict) =>
                  conflict.operatorName !== null ? `撞了${conflict.operatorName}师傅：${conflict.describe}` : conflict.describe,
                )
                .join('；')
            : `排练档期 ${slotText(slot)}`
        }
      >
        <Tag color={blocked ? 'red' : 'green'} icon={<CalendarOutlined />}>
          {slotText(slot)}
          {blocked ? ' 撞期' : ''}
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

  /** 导出排练通告 CSV：带场次、星期与参演师傅 */
  const handleExportNotice = async () => {
    const sceneIds = scenes.map((scene) => scene.id);
    const [roleRows, cueRows] = await Promise.all([listRolesByScenes(sceneIds), listCuesByScenes(sceneIds)]);
    const filename = exportPlayCsvFile(play, scenes, roleRows, cueRows, operators);
    message.success(`已导出排练通告：${filename}`);
  };

  /** 复制排练通告纯文本 */
  const handleCopyNotice = async () => {
    const roleRows = await listRolesByScenes(scenes.map((scene) => scene.id));
    const ok = await copyText(buildCallSheetText(play, scenes, roleRows, operators));
    if (ok) message.success('排练通告文本已复制，可贴给班社群里');
    else message.error('复制失败，请检查浏览器剪贴板权限');
  };

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
            <Button icon={<DownloadOutlined />} disabled={scenes.length === 0} onClick={() => void handleExportNotice()}>
              导出排练通告
            </Button>
            <Button icon={<CopyOutlined />} disabled={scenes.length === 0} onClick={() => void handleCopyNotice()}>
              复制通告文本
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title="整剧合计时长" value={totalMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="本次排练勾选" value={selectedSceneIds.length} suffix={`/ ${scenes.length} 场`} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="勾选场次合计" value={selectedMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="平均排练成熟度" value={playStat.averageProgress} suffix="%" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title={schedule.blockedCount > 0 ? `已排档期（撞期 ${schedule.blockedCount} 场）` : '已排档期'}
              value={scenes.filter((scene) => scene.rehearsalSlot !== null).length}
              suffix={`/ ${scenes.length} 场`}
              valueStyle={schedule.blockedCount > 0 ? { color: '#cf1322' } : undefined}
            />
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
                          scheduleTag={renderScheduleTag(item.scene)}
                          extraActions={
                            <Tag color={selectedSceneIds.includes(item.scene.id) ? '#7a1f1f' : 'default'}>
                              {selectedSceneIds.includes(item.scene.id) ? '本次排练' : '本次跳过'}
                            </Tag>
                          }
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
                  slotStatus={schedule.statusOf(activeItem.scene.id)}
                  onSave={updateScene}
                  onProgress={(delta) => void bumpProgress(activeItem.scene.id, delta)}
                  onDelete={() => confirmDelete(activeItem.scene.id, activeItem.scene.title)}
                  onRoles={() => navigate(ROUTES.roles(activeItem.scene.id))}
                  onCues={() => navigate(ROUTES.cues(activeItem.scene.id))}
                  onSchedule={() => setScheduleOpen(true)}
                  onClearSchedule={async () => {
                    await schedule.clear(activeItem.scene.id);
                    message.success('排练档期已取消');
                  }}
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

      <SceneScheduleModal
        open={scheduleOpen && activeItem !== null}
        scene={activeItem?.scene ?? null}
        cast={activeItem ? schedule.castOf(activeItem.scene.id) : []}
        preview={schedule.preview}
        onSave={schedule.save}
        onCancel={() => setScheduleOpen(false)}
      />
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
  slotStatus: SlotStatus;
  onSave: (
    sceneId: string,
    patch: Partial<Omit<SceneRow, 'id' | 'playId' | 'createdAt' | 'revision'>>,
  ) => Promise<void>;
  onProgress: (delta: number) => void;
  onDelete: () => void;
  onRoles: () => void;
  onCues: () => void;
  onSchedule: () => void;
  onClearSchedule: () => void;
}

function SceneDetailPanel({
  sceneId,
  startTimecode,
  accumulatedMinute,
  operatorCount,
  slotStatus,
  onSave,
  onProgress,
  onDelete,
  onRoles,
  onCues,
  onSchedule,
  onClearSchedule,
}: SceneDetailPanelProps) {
  const { message } = App.useApp();
  const scene = useSceneStore((state) => state.scenes.find((item) => item.id === sceneId) ?? null);
  const [title, setTitle] = useState(scene?.title ?? '');
  const [durationMin, setDurationMin] = useState(scene?.durationMin ?? 12);
  const [stageNote, setStageNote] = useState(scene?.stageNote ?? '');
  const [screen, setScreen] = useState(scene?.needsShadowScreen ?? 'standard');
  const [saving, setSaving] = useState(false);

  if (!scene) return null;

  const dirty =
    title !== scene.title ||
    durationMin !== scene.durationMin ||
    stageNote !== scene.stageNote ||
    screen !== scene.needsShadowScreen;

  const save = async () => {
    setSaving(true);
    await onSave(sceneId, {
      title: title.trim() || scene.title,
      durationMin: Math.max(1, Math.round(durationMin)),
      stageNote: stageNote.trim(),
      needsShadowScreen: screen,
    });
    setSaving(false);
    message.success('场次明细已保存');
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

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Text type="secondary">排练档期</Typography.Text>
          <Space size={4}>
            <Button size="small" type="primary" ghost icon={<CalendarOutlined />} onClick={onSchedule}>
              {scene.rehearsalSlot ? '改期' : '排定档期'}
            </Button>
            {scene.rehearsalSlot ? (
              <Button size="small" danger onClick={onClearSchedule}>
                取消档期
              </Button>
            ) : null}
          </Space>
        </Space>
        {scene.rehearsalSlot === null ? (
          <Alert
            style={{ marginTop: 6 }}
            type="info"
            showIcon
            message="尚未排定排练档期"
            description="选星期、起始时间和时长即可排定；保存前会先核对本场各影人操耍人的档期与别场排练，撞期会先搁下并报出撞了哪位师傅。"
          />
        ) : slotStatus.state === 'blocked' ? (
          <Alert
            style={{ marginTop: 6 }}
            type="error"
            showIcon
            message={`${slotText(scene.rehearsalSlot)} · 撞期 ${slotStatus.conflicts.length} 处，建议尽快改期`}
            description={
              <Space direction="vertical" size={2}>
                {slotStatus.conflicts.map((conflict, index) => (
                  <Typography.Text key={index} type="danger" style={{ fontSize: 12 }}>
                    {conflict.operatorName !== null
                      ? `撞了${conflict.operatorName}师傅${
                          conflict.roleNames.length > 0 ? `（${conflict.roleNames.join('、')}）` : ''
                        }：${conflict.describe}`
                      : conflict.describe}
                  </Typography.Text>
                ))}
              </Space>
            }
          />
        ) : (
          <Alert
            style={{ marginTop: 6 }}
            type="success"
            showIcon
            message={`${slotText(scene.rehearsalSlot)} · 排 ${minutesToReadable(scene.rehearsalSlot.durationMinute)}，无撞期`}
            description="该档期同时挡住后面别的场次；改场次时长或换操耍人后会自动重新判定。"
          />
        )}
      </div>

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
        当前影窗：{SHADOW_SCREEN_LABEL[scene.needsShadowScreen]}；修改场序请拖动左侧手柄，场序会自动重排并落库；已排档期会随场次时长联动并自动重判撞期。
      </Typography.Text>
    </Space>
  );
}
