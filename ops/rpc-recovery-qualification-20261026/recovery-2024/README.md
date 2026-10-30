# Deleted Base database recovery investigation

No database has been restored or accepted. All metadata candidates remain unauthenticated pending independent journal, inode and extent checksum checks. Current and historical block reuse and MDBX integrity are unresolved.

The local original journal is retained outside Git: 1,073,741,824 bytes, SHA256 d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073. Neither journal bytes nor database data are included here.

The candidate extent map accounts for the old inode allocation exactly, including 28 metadata blocks, with a possible sparse tail. This is evidence worth investigating, not proof of recoverability.

Qualification: producer r7 21 tests passed; integration r6 focused enrollment 19 passed with unchanged production bytes from r5. The r5 overall qualification failed and remains recorded as such. Journal parser 9 tests passed, but its wrapper incorrectly returned failure because buffered stdout followed the OK line. The exploratory inventory was run separately and is explicitly unauthenticated.

The integration r6 patch/job is preserved without duplicating the full Git pack. Its original SHA256SUMS references the full local stage; this archive is a selected source subset.
