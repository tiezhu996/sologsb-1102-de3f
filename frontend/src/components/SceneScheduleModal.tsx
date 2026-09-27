/**
 * <SceneScheduleModal> 场次排练档期排定弹窗
 * 选星期、起始时间与时长；保存前实时预检操耍人档期与别场排练，撞期则搁下不落库。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, App, InputNumber, Modal, Select, Space, TimePicker, Typography } from 'antd';
import { CalendarOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { SceneRow } from '../utils/db';
import type { RehearsalSlot } from '../types/scene';
import { DAY_BASE_HOUR, WEEKDAY_LABEL, WEEKDAY_OPTIONS, minuteToClock, type Weekday } from '../types/operator';
import { conflictOperatorNames, type ScheduleConflict } from '../utils/schedule';
import type { SlotSaveResult } from '../hooks/useSceneSchedule';
import { minutesToReadable } from '../utils/timecode';

/** 当日可选时段上界：24:00（相对 08:00 基准的分钟偏移） */
const DAY_END_MINUTE = (24 - DAY_BASE_HOUR) * 60;

export interface SceneScheduleModalProps {
  open: boolean;
  scene: SceneRow | null;
  /** 本场参演操耍人（含操耍角色），用于弹窗内亮底 */
  cast: Array<{ operatorName: string; roleNames: string[] }>;
  preview: (sceneId: string, slot: RehearsalSlot) => ScheduleConflict[];
  onSave: (sceneId: string, slot: RehearsalSlot) => Promise<SlotSaveResult>;
  onCancel: () => void;
}

export function SceneScheduleModal({ open, scene, cast, preview, onSave, onCancel }: SceneScheduleModalProps) {
  const { message } = App.useApp();
  const [weekday, setWeekday] = useState<Weekday>(1);
  const [start, setStart] = useState<dayjs.Dayjs>(dayjs().hour(DAY_BASE_HOUR + 1).minute(0));
  const [durationMinute, setDurationMinute] = useState(30);
  const [saving, setSaving] = useState(false);

  // 每次打开 / 切换场次时重置：已有档期回显，否则给默认值（时长随场次时长）
  useEffect(() => {
    if (!open || !scene) return;
    const slot = scene.rehearsalSlot;
    setWeekday(slot?.weekday ?? 1);
    const startMinute = slot?.startMinute ?? 60;
    setStart(dayjs().hour(DAY_BASE_HOUR).minute(0).add(startMinute, 'minute'));
    setDurationMinute(slot?.durationMinute ?? scene.durationMin);
  }, [open, scene]);

  const startMinute = start.hour() * 60 + start.minute() - DAY_BASE_HOUR * 60;
  const tooEarly = startMinute < 0;
  const tooLate = startMinute + durationMinute > DAY_END_MINUTE;
  const valid = !tooEarly && !tooLate && durationMinute > 0;

  const candidate: RehearsalSlot = {
    weekday,
    startMinute: Math.max(0, startMinute),
    durationMinute,
  };

  const conflicts = useMemo(() => {
    if (!open || !scene || !valid) return [];
    return preview(scene.id, { weekday, startMinute: Math.max(0, startMinute), durationMinute });
  }, [open, scene, valid, weekday, startMinute, durationMinute, preview]);

  const handleOk = async () => {
    if (!scene || !valid) return;
    setSaving(true);
    const result = await onSave(scene.id, candidate);
    setSaving(false);
    if (!result.ok) {
      const names = conflictOperatorNames(result.conflicts);
      message.warning(
        names.length > 0
          ? `与${names.join('、')}的档期相撞，这次安排先搁下了`
          : '与其他场次的排练时间相撞，这次安排先搁下了',
      );
      return;
    }
    message.success(
      `「${scene.title}」已排定：${WEEKDAY_LABEL[weekday]} ${minuteToClock(candidate.startMinute)} 起，排 ${minutesToReadable(durationMinute)}`,
    );
    onCancel();
  };

  return (
    <Modal
      open={open}
      title={
        <Space size={8}>
          <CalendarOutlined />
          {scene ? `排练档期 · 第 ${scene.seq} 场 ${scene.title}` : '排练档期'}
        </Space>
      }
      okText={scene?.rehearsalSlot ? '保存改期' : '排定档期'}
      cancelText="取消"
      okButtonProps={{ disabled: !valid, loading: saving }}
      onOk={() => void handleOk()}
      onCancel={onCancel}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Typography.Text type="secondary">排练日</Typography.Text>
          <Select<Weekday>
            style={{ width: '100%' }}
            value={weekday}
            options={[...WEEKDAY_OPTIONS]}
            onChange={setWeekday}
          />
        </div>
        <Space size={12} style={{ width: '100%' }}>
          <div style={{ flex: 1 }}>
            <Typography.Text type="secondary">起始时间（08:00 起算）</Typography.Text>
            <TimePicker
              style={{ width: '100%' }}
              format="HH:mm"
              minuteStep={15}
              value={start}
              onChange={(value) => value && setStart(value)}
              allowClear={false}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Typography.Text type="secondary">时长（分钟）</Typography.Text>
            <InputNumber
              style={{ width: '100%' }}
              min={5}
              max={480}
              step={5}
              value={durationMinute}
              onChange={(value) => setDurationMinute(typeof value === 'number' ? value : scene?.durationMin ?? 30)}
            />
          </div>
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          本场参演：
          {cast.length > 0
            ? cast.map((item) => `${item.operatorName}（${item.roleNames.join('、')}）`).join('；')
            : '尚未指派操耍人，暂只与别场排练档期互挡'}
          。时长默认随场次时长（当前 {scene?.durationMin ?? 0} 分钟），此后修改场次时长会同步更新档期并重新判定。
        </Typography.Text>

        {!valid ? (
          <Alert
            type="warning"
            showIcon
            message={tooEarly ? '起始时间请在 08:00 之后' : '时段会跨到次日，请提前起始时间或缩短时长'}
          />
        ) : conflicts.length > 0 ? (
          <Alert
            type="error"
            showIcon
            message={`该时段撞期 ${conflicts.length} 处，保存会被搁下`}
            description={
              <Space direction="vertical" size={2}>
                {conflicts.map((conflict, index) => (
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
          <Alert type="success" showIcon message="该时段可排：参演师傅档期都空着，也不与别场排练相撞" />
        )}
      </Space>
    </Modal>
  );
}

export default SceneScheduleModal;
