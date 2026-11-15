import type { DataSource } from 'typeorm';

/**
 * Egasi tanlagan step-up istisnosi (`settings['commands.stepup_exempt_device_ids']`): hozir faqat shu Mac'dagi lokal
 * dashboard qurilmasi. CommandsService bilan BIR xil manba (foydalanuvchi qarori: "Mac'da ochilsa tasdiq kerak emas").
 */
export async function isStepUpExemptDevice(dataSource: DataSource, deviceId: string): Promise<boolean> {
  const rows: Array<{ value: unknown }> = await dataSource.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
  const v = rows[0]?.value;
  return Array.isArray(v) && v.includes(deviceId);
}
