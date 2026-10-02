import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Establishment } from '../entities/establishment.entity';
import { EmissionPoint } from '../entities/emission-point.entity';
import { Company } from '../entities/company.entity';
import { Document } from '../entities/document.entity';
import { CreateEstablishmentDto, UpdateEstablishmentDto } from './dto/establishment.dto';

@Injectable()
export class EstablishmentsService {
  constructor(
    @InjectRepository(Establishment)
    private readonly repo: Repository<Establishment>,
    @InjectRepository(EmissionPoint)
    private readonly pointRepo: Repository<EmissionPoint>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
  ) {}

  async findAll(companyId: number) {
    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    const establishments = await this.repo.find({
      where: { companyId },
      relations: ['emissionPoints'],
      order: { code: 'ASC' },
    });

    return establishments.map((e) => ({
      id: e.id,
      code: e.code,
      name: e.name,
      address: e.address,
      isActive: e.isActive,
      isMain: e.code === company?.establishment,
      emissionPoints: (e.emissionPoints ?? [])
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((p) => ({ id: p.id, code: p.code, description: p.description, isActive: p.isActive })),
    }));
  }

  async create(companyId: number, dto: CreateEstablishmentDto) {
    const exists = await this.repo.findOne({ where: { companyId, code: dto.code } });
    if (exists) {
      throw new ConflictException(`La empresa ya tiene el establecimiento ${dto.code}`);
    }

    const establishment = await this.repo.save(
      this.repo.create({
        companyId,
        code: dto.code,
        name: dto.name ?? null,
        address: dto.address ?? null,
      }),
    );

    // Toda sucursal necesita al menos un punto de emisión para poder facturar.
    await this.pointRepo.save(
      this.pointRepo.create({
        companyId,
        establishmentId: establishment.id,
        code: '001',
        description: 'Punto de emisión principal',
      }),
    );

    return this.findOneOrFail(companyId, establishment.id);
  }

  async update(companyId: number, establishmentId: number, dto: UpdateEstablishmentDto) {
    const establishment = await this.findOneOrFail(companyId, establishmentId);
    Object.assign(establishment, {
      name: dto.name ?? establishment.name,
      address: dto.address ?? establishment.address,
      isActive: dto.isActive ?? establishment.isActive,
    });
    await this.repo.save(establishment);
    return this.findOneOrFail(companyId, establishmentId);
  }

  async remove(companyId: number, establishmentId: number) {
    const establishment = await this.findOneOrFail(companyId, establishmentId);
    const company = await this.companyRepo.findOne({ where: { id: companyId } });

    if (company && establishment.code === company.establishment) {
      throw new BadRequestException(
        'No se puede eliminar el establecimiento principal de la empresa. ' +
        'Cambie primero el establecimiento principal.',
      );
    }

    const emitidos = await this.docRepo.count({
      where: { companyId, establishment: establishment.code },
    });
    if (emitidos > 0) {
      throw new BadRequestException(
        `El establecimiento ${establishment.code} tiene ${emitidos} comprobante(s) emitidos y no se puede eliminar. ` +
        'Puede desactivarlo en su lugar.',
      );
    }

    await this.repo.remove(establishment);
    return { deleted: true };
  }

  /**
   * Devuelve el establecimiento desde el que se va a emitir. Si no se indica
   * ninguno, se usa el principal de la empresa, que es el comportamiento de
   * todas las integraciones que no envían el campo.
   */
  async resolveForEmission(company: Company, code?: string): Promise<Establishment> {
    const target = code ?? company.establishment;
    const establishment = await this.ensureExists(company.id, target);

    if (!establishment.isActive) {
      throw new BadRequestException(
        `El establecimiento "${target}" está desactivado. Actívelo para poder emitir.`,
      );
    }
    return establishment;
  }

  /**
   * Busca el establecimiento y, si no existe pero es el principal de la empresa,
   * lo crea. Cubre a las empresas que cambian su establecimiento principal.
   */
  async ensureExists(companyId: number, code: string): Promise<Establishment> {
    const found = await this.repo.findOne({ where: { companyId, code } });
    if (found) return found;

    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (company && company.establishment === code) {
      const created = await this.repo.save(
        this.repo.create({
          companyId,
          code,
          name: 'Matriz',
          address: company.address ?? null,
        }),
      );
      return created;
    }

    throw new BadRequestException(
      `El establecimiento "${code}" no existe para esta empresa. ` +
      'Créelo primero o use el establecimiento principal.',
    );
  }

  private async findOneOrFail(companyId: number, establishmentId: number) {
    const establishment = await this.repo.findOne({
      where: { id: establishmentId, companyId },
      relations: ['emissionPoints'],
    });
    if (!establishment) throw new NotFoundException('Establecimiento no encontrado');
    return establishment;
  }
}
