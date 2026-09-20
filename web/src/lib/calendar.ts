/**
 * Las reglas del calendario de tipo de cambio: una sección por mes, una fila por semana de ese
 * mes, del más reciente al más antiguo.
 *
 * Portado de genix (routes/finance/exchange-rate/exchange-rate.ts), quitándole el borrador de
 * edición: aquí el dato se lee de los archivos publicados y no se puede escribir, así que no hay
 * `IMonthDraft`, ni `isDirty`, ni parseo de lo tecleado. Lo que sí se conserva es la forma de la
 * tabla, porque es la misma tabla.
 */

import type { IExchangeRateDay } from '$client'

/** Cuántos meses muestra el calendario: el mes actual y los cinco años anteriores. */
export const MONTHS_OFFERED = 60

/** Índice 0 es enero. */
export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** Lunes primero, que es el orden de las columnas. */
export const WEEKDAY_NAMES = [
  'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo',
]

/** Cuál de las dos cotizaciones publica una celda. */
export type RateKind = 'buyScaled' | 'sellScaled'

/**
 * Una fila del calendario: o el separador de mes a todo lo ancho, o una semana. Una semana lleva
 * el número de día por cada día de la semana, y 0 donde la semana cae fuera del mes — esos días
 * pertenecen a la sección del mes vecino.
 */
export interface ICalendarRow {
  IsMonthHeader: boolean
  /** El mes en forma YYMM: 2601 es enero de 2026. */
  MonthKey: number
  Days: number[]
}

/** Enero de 2026 → 2601. */
export function toMonthKey(year: number, monthIndex: number): number {
  return (year - 2000) * 100 + monthIndex + 1
}

/** 2601 → 2026. */
export function yearOfMonthKey(monthKey: number): number {
  return 2000 + Math.floor(monthKey / 100)
}

/** 2601 → 0 (enero). */
export function monthIndexOfMonthKey(monthKey: number): number {
  return (monthKey % 100) - 1
}

/** Los días que el mes tiene de verdad — el día 0 del siguiente es el último de este. */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** Los meses que muestra el calendario, del más reciente al más antiguo. */
export function calendarMonthKeys(fromDate: Date, monthsCount: number): number[] {
  const monthKeys: number[] = []
  for (let monthsBack = 0; monthsBack < monthsCount; monthsBack++) {
    const month = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth() - monthsBack, 1))
    monthKeys.push(toMonthKey(month.getUTCFullYear(), month.getUTCMonth()))
  }
  return monthKeys
}

/**
 * El mes partido en semanas que empiezan en lunes. Cada semana son siete casillas con el número
 * de día, o 0 donde la semana corre antes del 1 o pasado el último día.
 */
export function weeksOfMonth(year: number, monthIndex: number): number[][] {
  const lastDay = daysInMonth(year, monthIndex)
  // getUTCDay() cuenta desde el domingo; el calendario empieza en lunes.
  let weekdayIndex = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7

  const weeks: number[][] = []
  let currentWeek = new Array<number>(7).fill(0)

  for (let day = 1; day <= lastDay; day++) {
    currentWeek[weekdayIndex] = day
    weekdayIndex++
    if (weekdayIndex === 7) {
      weeks.push(currentWeek)
      currentWeek = new Array<number>(7).fill(0)
      weekdayIndex = 0
    }
  }
  if (weekdayIndex > 0) weeks.push(currentWeek)

  return weeks
}

/** El calendario como filas planas: un separador de mes seguido de sus semanas, mes tras mes. */
export function buildCalendarRows(monthKeys: number[]): ICalendarRow[] {
  const rows: ICalendarRow[] = []

  for (const monthKey of monthKeys) {
    rows.push({ IsMonthHeader: true, MonthKey: monthKey, Days: [] })
    for (const week of weeksOfMonth(yearOfMonthKey(monthKey), monthIndexOfMonthKey(monthKey))) {
      rows.push({ IsMonthHeader: false, MonthKey: monthKey, Days: week })
    }
  }
  return rows
}

/** 'SEPTIEMBRE 2026' — lo que va en la fila separadora. */
export function monthTitle(monthKey: number): string {
  return `${MONTH_NAMES[monthIndexOfMonthKey(monthKey)]} ${yearOfMonthKey(monthKey)}`.toUpperCase()
}

/**
 * Los días publicados indexados por fecha ISO. La descarga masiva llega como un array ordenado y
 * la tabla pregunta por celda, así que se indexa una vez en vez de buscar 1 800 veces.
 */
export function indexRatesByDate(days: IExchangeRateDay[]): Map<string, IExchangeRateDay> {
  return new Map(days.map((day) => [day.date, day]))
}

/** La clave con la que una celda busca su cotización. */
export function dateKeyOf(monthKey: number, day: number): string {
  const year = yearOfMonthKey(monthKey)
  const month = String(monthIndexOfMonthKey(monthKey) + 1).padStart(2, '0')
  return `${year}-${month}-${String(day).padStart(2, '0')}`
}

/** 3354 → '3.354'. Siempre los tres decimales que publica SUNAT, sin recortar ceros. */
export function formatRate(scaled: number): string {
  return scaled ? (scaled / 1000).toFixed(3) : ''
}
