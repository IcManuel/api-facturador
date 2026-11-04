import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentError } from '../../entities/document-error.entity';
import { Document } from '../../entities/document.entity';
import { ymdEc } from '../../common/utils/date.util';

const DOC_TYPE_LABELS: Record<string, string> = {
  '01': 'Factura',
  '03': 'Liq. Compras',
  '04': 'Nota Crédito',
  '05': 'Nota Débito',
  '06': 'Guía Remisión',
  '07': 'Retención',
};

@Injectable()
export class ErrorAnalyticsService {
  constructor(
    @InjectRepository(DocumentError)
    private readonly errorRepo: Repository<DocumentError>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
  ) {}

  private buildWhereAndParams(filters: {
    from?: string;
    to?: string;
    category?: string;
    severity?: string;
    companyId?: number;
    docTypeCode?: string;
    env?: string;
  }) {
    const now = new Date();
    const fromDate = filters.from
      ? new Date(filters.from)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const toDate = filters.to
      ? new Date(filters.to + 'T23:59:59.999')
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const conditions: string[] = ['e.der_created_at >= $1', 'e.der_created_at <= $2'];
    const params: any[] = [fromDate, toDate];
    let paramIdx = 3;

    if (filters.category) {
      conditions.push(`e.der_category = $${paramIdx++}`);
      params.push(filters.category);
    }
    if (filters.severity) {
      conditions.push(`e.der_severity = $${paramIdx++}`);
      params.push(filters.severity);
    }
    if (filters.companyId) {
      conditions.push(`d.com_id = $${paramIdx++}`);
      params.push(filters.companyId);
    }
    if (filters.docTypeCode) {
      conditions.push(`d.doc_type_code = $${paramIdx++}`);
      params.push(filters.docTypeCode);
    }
    if (filters.env) {
      conditions.push(`d.doc_env = $${paramIdx++}`);
      params.push(filters.env);
    }

    return { where: conditions.join(' AND '), params, paramIdx };
  }

  async getRecentErrors(
    filters: {
      from?: string;
      to?: string;
      category?: string;
      severity?: string;
      companyId?: number;
      docTypeCode?: string;
      env?: string;
    },
    page = 1,
    limit = 15,
  ) {
    const { where, params, paramIdx } = this.buildWhereAndParams(filters);
    const joinDoc = 'JOIN app.document d ON e.doc_id = d.doc_id';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      this.errorRepo.query(
        `SELECT e.der_id as id, e.der_code as code, e.der_message as message,
                e.der_detail as detail, e.der_category as category,
                e.der_severity as severity, e.der_field as field,
                e.der_created_at as "createdAt",
                d.doc_id as "docId", d.doc_sequential as sequential,
                d.doc_type_code as "docTypeCode", d.doc_status as "docStatus",
                c.com_name as "companyName", c.com_ruc as "companyRuc"
         FROM app.document_error e ${joinDoc}
         JOIN app.company c ON d.com_id = c.com_id
         WHERE ${where}
         ORDER BY e.der_created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
      this.errorRepo.query(
        `SELECT COUNT(*) as count FROM app.document_error e ${joinDoc} WHERE ${where}`,
        params,
      ),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    return {
      data: (rows || []).map((r: any) => ({
        ...r,
        id: Number(r.id),
        docId: Number(r.docId),
        docTypeLabel: DOC_TYPE_LABELS[r.docTypeCode] || r.docTypeCode,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getAnalytics(filters: {
    from?: string;
    to?: string;
    category?: string;
    severity?: string;
    companyId?: number;
    docTypeCode?: string;
    env?: string;
  }) {
    const { where, params } = this.buildWhereAndParams(filters);
    const joinDoc = 'JOIN app.document d ON e.doc_id = d.doc_id';

    const [
      topErrorCodes,
      topErrorMessages,
      bySeverity,
      byCategory,
      byDocType,
      byCompany,
      dailyTrend,
      topFields,
      totalErrors,
      recentErrors,
    ] = await Promise.all([
      // Top 10 error codes
      this.errorRepo.query(
        `SELECT e.der_code as code, e.der_message as message, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY e.der_code, e.der_message
         ORDER BY count DESC
         LIMIT 10`,
        params,
      ),

      // Top 15 unique error messages (grouped by message text)
      this.errorRepo.query(
        `SELECT e.der_message as message, e.der_category as category,
                e.der_severity as severity, COUNT(*) as count,
                MAX(e.der_created_at) as "lastSeen"
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY e.der_message, e.der_category, e.der_severity
         ORDER BY count DESC
         LIMIT 15`,
        params,
      ),

      // By severity
      this.errorRepo.query(
        `SELECT e.der_severity as severity, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY e.der_severity
         ORDER BY count DESC`,
        params,
      ),

      // By category
      this.errorRepo.query(
        `SELECT e.der_category as category, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY e.der_category`,
        params,
      ),

      // By document type
      this.errorRepo.query(
        `SELECT d.doc_type_code as code, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY d.doc_type_code
         ORDER BY count DESC`,
        params,
      ),

      // By company (top 10)
      this.errorRepo.query(
        `SELECT c.com_id as id, c.com_name as name, c.com_ruc as ruc, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         JOIN app.company c ON d.com_id = c.com_id
         WHERE ${where}
         GROUP BY c.com_id, c.com_name, c.com_ruc
         ORDER BY count DESC
         LIMIT 10`,
        params,
      ),

      // Daily trend
      this.errorRepo.query(
        `SELECT e.der_created_at::date as date,
                COUNT(*) FILTER (WHERE e.der_category = 'client') as client,
                COUNT(*) FILTER (WHERE e.der_category = 'system') as system
         FROM app.document_error e ${joinDoc}
         WHERE ${where}
         GROUP BY date
         ORDER BY date ASC`,
        params,
      ),

      // Top fields with errors
      this.errorRepo.query(
        `SELECT e.der_field as field, COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where} AND e.der_field IS NOT NULL
         GROUP BY e.der_field
         ORDER BY count DESC
         LIMIT 10`,
        params,
      ),

      // Total error count
      this.errorRepo.query(
        `SELECT COUNT(*) as count
         FROM app.document_error e ${joinDoc}
         WHERE ${where}`,
        params,
      ).then((r) => Number(r[0]?.count ?? 0)),

      // Recent 10 errors (preview)
      this.errorRepo.query(
        `SELECT e.der_id as id, e.der_code as code, e.der_message as message,
                e.der_detail as detail, e.der_category as category,
                e.der_severity as severity, e.der_field as field,
                e.der_created_at as "createdAt",
                d.doc_id as "docId", d.doc_sequential as sequential,
                d.doc_type_code as "docTypeCode", d.doc_status as "docStatus",
                c.com_name as "companyName", c.com_ruc as "companyRuc"
         FROM app.document_error e ${joinDoc}
         JOIN app.company c ON d.com_id = c.com_id
         WHERE ${where}
         ORDER BY e.der_created_at DESC
         LIMIT 10`,
        params,
      ),
    ]);

    // Enrich doc type codes with labels
    const byDocTypeLabeled = (byDocType || []).map(
      (row: { code: string; count: string }) => ({
        code: row.code,
        label: DOC_TYPE_LABELS[row.code] || row.code,
        count: Number(row.count),
      }),
    );

    // Format daily trend
    const trend = (dailyTrend || []).map(
      (row: { date: any; client: string; system: string }) => ({
        date:
          row.date instanceof Date
            ? ymdEc(row.date)
            : String(row.date).slice(0, 10),
        client: Number(row.client),
        system: Number(row.system),
      }),
    );

    // Total recent errors for pagination info
    const totalRecentErrors = totalErrors;

    return {
      totalErrors,
      totalRecentErrors,
      topErrorCodes: (topErrorCodes || []).map((r: any) => ({
        code: r.code,
        message: r.message,
        count: Number(r.count),
      })),
      topErrorMessages: (topErrorMessages || []).map((r: any) => ({
        message: r.message,
        category: r.category,
        severity: r.severity,
        count: Number(r.count),
        lastSeen: r.lastSeen,
      })),
      bySeverity: (bySeverity || []).map((r: any) => ({
        severity: r.severity,
        count: Number(r.count),
      })),
      byCategory: (byCategory || []).map((r: any) => ({
        category: r.category,
        count: Number(r.count),
      })),
      byDocType: byDocTypeLabeled,
      byCompany: (byCompany || []).map((r: any) => ({
        id: Number(r.id),
        name: r.name,
        ruc: r.ruc,
        count: Number(r.count),
      })),
      dailyTrend: trend,
      topFields: (topFields || []).map((r: any) => ({
        field: r.field,
        count: Number(r.count),
      })),
      recentErrors: (recentErrors || []).map((r: any) => ({
        ...r,
        id: Number(r.id),
        docId: Number(r.docId),
        docTypeLabel: DOC_TYPE_LABELS[r.docTypeCode] || r.docTypeCode,
      })),
    };
  }
}
