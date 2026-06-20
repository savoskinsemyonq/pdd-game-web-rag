from pydantic import BaseModel, Field


class ChunkMetadata(BaseModel):
    chunk_id: str
    source_type: str
    section_title: str
    paragraph: str
    law_ref: str
    source_file: str
    token_count: int
    char_count: int
    title: str = ""


class Chunk(BaseModel):
    text: str
    metadata: ChunkMetadata
