/** Test-only request schemas from googleapis/google-api-go-client v0.297.0.
Copyright (c) 2011 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
export const documentAPISchemas = {
  docs: {
    root: "BatchUpdateDocumentRequest",
    revision: "20260427",
    schemas: {
      BatchUpdateDocumentRequest: {
        properties: {
          requests: { items: { $ref: "Request" }, type: "array" },
          writeControl: { $ref: "WriteControl" },
        },
        type: "object",
      },
      Request: {
        properties: {
          addDocumentTab: { $ref: "AddDocumentTabRequest" },
          createFooter: { $ref: "CreateFooterRequest" },
          createFootnote: { $ref: "CreateFootnoteRequest" },
          createHeader: { $ref: "CreateHeaderRequest" },
          createNamedRange: { $ref: "CreateNamedRangeRequest" },
          createParagraphBullets: { $ref: "CreateParagraphBulletsRequest" },
          deleteContentRange: { $ref: "DeleteContentRangeRequest" },
          deleteFooter: { $ref: "DeleteFooterRequest" },
          deleteHeader: { $ref: "DeleteHeaderRequest" },
          deleteNamedRange: { $ref: "DeleteNamedRangeRequest" },
          deleteParagraphBullets: { $ref: "DeleteParagraphBulletsRequest" },
          deletePositionedObject: { $ref: "DeletePositionedObjectRequest" },
          deleteTab: { $ref: "DeleteTabRequest" },
          deleteTableColumn: { $ref: "DeleteTableColumnRequest" },
          deleteTableRow: { $ref: "DeleteTableRowRequest" },
          insertDate: { $ref: "InsertDateRequest" },
          insertInlineImage: { $ref: "InsertInlineImageRequest" },
          insertPageBreak: { $ref: "InsertPageBreakRequest" },
          insertPerson: { $ref: "InsertPersonRequest" },
          insertRichLink: { $ref: "InsertRichLinkRequest" },
          insertSectionBreak: { $ref: "InsertSectionBreakRequest" },
          insertTable: { $ref: "InsertTableRequest" },
          insertTableColumn: { $ref: "InsertTableColumnRequest" },
          insertTableRow: { $ref: "InsertTableRowRequest" },
          insertText: { $ref: "InsertTextRequest" },
          mergeTableCells: { $ref: "MergeTableCellsRequest" },
          pinTableHeaderRows: { $ref: "PinTableHeaderRowsRequest" },
          replaceAllText: { $ref: "ReplaceAllTextRequest" },
          replaceImage: { $ref: "ReplaceImageRequest" },
          replaceNamedRangeContent: { $ref: "ReplaceNamedRangeContentRequest" },
          unmergeTableCells: { $ref: "UnmergeTableCellsRequest" },
          updateDocumentStyle: { $ref: "UpdateDocumentStyleRequest" },
          updateDocumentTabProperties: {
            $ref: "UpdateDocumentTabPropertiesRequest",
          },
          updateNamedStyle: { $ref: "UpdateNamedStyleRequest" },
          updateParagraphStyle: { $ref: "UpdateParagraphStyleRequest" },
          updateSectionStyle: { $ref: "UpdateSectionStyleRequest" },
          updateTableCellStyle: { $ref: "UpdateTableCellStyleRequest" },
          updateTableColumnProperties: {
            $ref: "UpdateTableColumnPropertiesRequest",
          },
          updateTableRowStyle: { $ref: "UpdateTableRowStyleRequest" },
          updateTextStyle: { $ref: "UpdateTextStyleRequest" },
        },
        type: "object",
      },
      AddDocumentTabRequest: {
        properties: { tabProperties: { $ref: "TabProperties" } },
        type: "object",
      },
      TabProperties: {
        properties: {
          iconEmoji: { type: "string" },
          index: { format: "int32", type: "integer" },
          nestingLevel: { format: "int32", type: "integer" },
          parentTabId: { type: "string" },
          tabId: { type: "string" },
          title: { type: "string" },
        },
        type: "object",
      },
      CreateFooterRequest: {
        properties: {
          sectionBreakLocation: { $ref: "Location" },
          type: {
            enum: ["HEADER_FOOTER_TYPE_UNSPECIFIED", "DEFAULT"],
            type: "string",
          },
        },
        type: "object",
      },
      Location: {
        properties: {
          index: { format: "int32", type: "integer" },
          segmentId: { type: "string" },
          tabId: { type: "string" },
        },
        type: "object",
      },
      CreateFootnoteRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
        },
        type: "object",
      },
      EndOfSegmentLocation: {
        properties: {
          segmentId: { type: "string" },
          tabId: { type: "string" },
        },
        type: "object",
      },
      CreateHeaderRequest: {
        properties: {
          sectionBreakLocation: { $ref: "Location" },
          type: {
            enum: ["HEADER_FOOTER_TYPE_UNSPECIFIED", "DEFAULT"],
            type: "string",
          },
        },
        type: "object",
      },
      CreateNamedRangeRequest: {
        properties: { name: { type: "string" }, range: { $ref: "Range" } },
        type: "object",
      },
      Range: {
        properties: {
          endIndex: { format: "int32", type: "integer" },
          segmentId: { type: "string" },
          startIndex: { format: "int32", type: "integer" },
          tabId: { type: "string" },
        },
        type: "object",
      },
      CreateParagraphBulletsRequest: {
        properties: {
          bulletPreset: {
            enum: [
              "BULLET_GLYPH_PRESET_UNSPECIFIED",
              "BULLET_DISC_CIRCLE_SQUARE",
              "BULLET_DIAMONDX_ARROW3D_SQUARE",
              "BULLET_CHECKBOX",
              "BULLET_ARROW_DIAMOND_DISC",
              "BULLET_STAR_CIRCLE_SQUARE",
              "BULLET_ARROW3D_CIRCLE_SQUARE",
              "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
              "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE",
              "BULLET_DIAMOND_CIRCLE_SQUARE",
              "NUMBERED_DECIMAL_ALPHA_ROMAN",
              "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS",
              "NUMBERED_DECIMAL_NESTED",
              "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
              "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL",
              "NUMBERED_ZERODECIMAL_ALPHA_ROMAN",
            ],
            type: "string",
          },
          range: { $ref: "Range" },
        },
        type: "object",
      },
      DeleteContentRangeRequest: {
        properties: { range: { $ref: "Range" } },
        type: "object",
      },
      DeleteFooterRequest: {
        properties: { footerId: { type: "string" }, tabId: { type: "string" } },
        type: "object",
      },
      DeleteHeaderRequest: {
        properties: { headerId: { type: "string" }, tabId: { type: "string" } },
        type: "object",
      },
      DeleteNamedRangeRequest: {
        properties: {
          name: { type: "string" },
          namedRangeId: { type: "string" },
          tabsCriteria: { $ref: "TabsCriteria" },
        },
        type: "object",
      },
      TabsCriteria: {
        properties: { tabIds: { items: { type: "string" }, type: "array" } },
        type: "object",
      },
      DeleteParagraphBulletsRequest: {
        properties: { range: { $ref: "Range" } },
        type: "object",
      },
      DeletePositionedObjectRequest: {
        properties: { objectId: { type: "string" }, tabId: { type: "string" } },
        type: "object",
      },
      DeleteTabRequest: {
        properties: { tabId: { type: "string" } },
        type: "object",
      },
      DeleteTableColumnRequest: {
        properties: { tableCellLocation: { $ref: "TableCellLocation" } },
        type: "object",
      },
      TableCellLocation: {
        properties: {
          columnIndex: { format: "int32", type: "integer" },
          rowIndex: { format: "int32", type: "integer" },
          tableStartLocation: { $ref: "Location" },
        },
        type: "object",
      },
      DeleteTableRowRequest: {
        properties: { tableCellLocation: { $ref: "TableCellLocation" } },
        type: "object",
      },
      InsertDateRequest: {
        properties: {
          dateElementProperties: { $ref: "DateElementProperties" },
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
        },
        type: "object",
      },
      DateElementProperties: {
        properties: {
          dateFormat: {
            enum: [
              "DATE_FORMAT_UNSPECIFIED",
              "DATE_FORMAT_CUSTOM",
              "DATE_FORMAT_MONTH_DAY_ABBREVIATED",
              "DATE_FORMAT_MONTH_DAY_FULL",
              "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
              "DATE_FORMAT_ISO8601",
            ],
            type: "string",
          },
          displayText: { type: "string" },
          locale: { type: "string" },
          timeFormat: {
            enum: [
              "TIME_FORMAT_UNSPECIFIED",
              "TIME_FORMAT_DISABLED",
              "TIME_FORMAT_HOUR_MINUTE",
              "TIME_FORMAT_HOUR_MINUTE_TIMEZONE",
            ],
            type: "string",
          },
          timeZoneId: { type: "string" },
          timestamp: { format: "google-datetime", type: "string" },
        },
        type: "object",
      },
      InsertInlineImageRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          objectSize: { $ref: "Size" },
          uri: { type: "string" },
        },
        type: "object",
      },
      Size: {
        properties: {
          height: { $ref: "Dimension" },
          width: { $ref: "Dimension" },
        },
        type: "object",
      },
      Dimension: {
        properties: {
          magnitude: { format: "double", type: "number" },
          unit: { enum: ["UNIT_UNSPECIFIED", "PT"], type: "string" },
        },
        type: "object",
      },
      InsertPageBreakRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
        },
        type: "object",
      },
      InsertPersonRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          personProperties: { $ref: "PersonProperties" },
        },
        type: "object",
      },
      PersonProperties: {
        properties: { email: { type: "string" }, name: { type: "string" } },
        type: "object",
      },
      InsertRichLinkRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          richLinkProperties: { $ref: "RichLinkProperties" },
        },
        type: "object",
      },
      RichLinkProperties: {
        properties: {
          mimeType: { type: "string" },
          title: { type: "string" },
          uri: { type: "string" },
        },
        type: "object",
      },
      InsertSectionBreakRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          sectionType: {
            enum: ["SECTION_TYPE_UNSPECIFIED", "CONTINUOUS", "NEXT_PAGE"],
            type: "string",
          },
        },
        type: "object",
      },
      InsertTableRequest: {
        properties: {
          columns: { format: "int32", type: "integer" },
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          rows: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      InsertTableColumnRequest: {
        properties: {
          insertRight: { type: "boolean" },
          tableCellLocation: { $ref: "TableCellLocation" },
        },
        type: "object",
      },
      InsertTableRowRequest: {
        properties: {
          insertBelow: { type: "boolean" },
          tableCellLocation: { $ref: "TableCellLocation" },
        },
        type: "object",
      },
      InsertTextRequest: {
        properties: {
          endOfSegmentLocation: { $ref: "EndOfSegmentLocation" },
          location: { $ref: "Location" },
          text: { type: "string" },
        },
        type: "object",
      },
      MergeTableCellsRequest: {
        properties: { tableRange: { $ref: "TableRange" } },
        type: "object",
      },
      TableRange: {
        properties: {
          columnSpan: { format: "int32", type: "integer" },
          rowSpan: { format: "int32", type: "integer" },
          tableCellLocation: { $ref: "TableCellLocation" },
        },
        type: "object",
      },
      PinTableHeaderRowsRequest: {
        properties: {
          pinnedHeaderRowsCount: { format: "int32", type: "integer" },
          tableStartLocation: { $ref: "Location" },
        },
        type: "object",
      },
      ReplaceAllTextRequest: {
        properties: {
          containsText: { $ref: "SubstringMatchCriteria" },
          replaceText: { type: "string" },
          tabsCriteria: { $ref: "TabsCriteria" },
        },
        type: "object",
      },
      SubstringMatchCriteria: {
        properties: {
          matchCase: { type: "boolean" },
          searchByRegex: { type: "boolean" },
          text: { type: "string" },
        },
        type: "object",
      },
      ReplaceImageRequest: {
        properties: {
          imageObjectId: { type: "string" },
          imageReplaceMethod: {
            enum: ["IMAGE_REPLACE_METHOD_UNSPECIFIED", "CENTER_CROP"],
            type: "string",
          },
          tabId: { type: "string" },
          uri: { type: "string" },
        },
        type: "object",
      },
      ReplaceNamedRangeContentRequest: {
        properties: {
          namedRangeId: { type: "string" },
          namedRangeName: { type: "string" },
          tabsCriteria: { $ref: "TabsCriteria" },
          text: { type: "string" },
        },
        type: "object",
      },
      UnmergeTableCellsRequest: {
        properties: { tableRange: { $ref: "TableRange" } },
        type: "object",
      },
      UpdateDocumentStyleRequest: {
        properties: {
          documentStyle: { $ref: "DocumentStyle" },
          fields: { format: "google-fieldmask", type: "string" },
          tabId: { type: "string" },
        },
        type: "object",
      },
      DocumentStyle: {
        properties: {
          background: { $ref: "Background" },
          defaultFooterId: { type: "string" },
          defaultHeaderId: { type: "string" },
          documentFormat: { $ref: "DocumentFormat" },
          evenPageFooterId: { type: "string" },
          evenPageHeaderId: { type: "string" },
          firstPageFooterId: { type: "string" },
          firstPageHeaderId: { type: "string" },
          flipPageOrientation: { type: "boolean" },
          marginBottom: { $ref: "Dimension" },
          marginFooter: { $ref: "Dimension" },
          marginHeader: { $ref: "Dimension" },
          marginLeft: { $ref: "Dimension" },
          marginRight: { $ref: "Dimension" },
          marginTop: { $ref: "Dimension" },
          pageNumberStart: { format: "int32", type: "integer" },
          pageSize: { $ref: "Size" },
          useCustomHeaderFooterMargins: { type: "boolean" },
          useEvenPageHeaderFooter: { type: "boolean" },
          useFirstPageHeaderFooter: { type: "boolean" },
        },
        type: "object",
      },
      Background: {
        properties: { color: { $ref: "OptionalColor" } },
        type: "object",
      },
      OptionalColor: {
        properties: { color: { $ref: "Color" } },
        type: "object",
      },
      Color: { properties: { rgbColor: { $ref: "RgbColor" } }, type: "object" },
      RgbColor: {
        properties: {
          blue: { format: "float", type: "number" },
          green: { format: "float", type: "number" },
          red: { format: "float", type: "number" },
        },
        type: "object",
      },
      DocumentFormat: {
        properties: {
          documentMode: {
            enum: ["DOCUMENT_MODE_UNSPECIFIED", "PAGES", "PAGELESS"],
            type: "string",
          },
        },
        type: "object",
      },
      UpdateDocumentTabPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          tabProperties: { $ref: "TabProperties" },
        },
        type: "object",
      },
      UpdateNamedStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          namedStyle: { $ref: "NamedStyle" },
          tabId: { type: "string" },
        },
        type: "object",
      },
      NamedStyle: {
        properties: {
          namedStyleType: {
            enum: [
              "NAMED_STYLE_TYPE_UNSPECIFIED",
              "NORMAL_TEXT",
              "TITLE",
              "SUBTITLE",
              "HEADING_1",
              "HEADING_2",
              "HEADING_3",
              "HEADING_4",
              "HEADING_5",
              "HEADING_6",
            ],
            type: "string",
          },
          paragraphStyle: { $ref: "ParagraphStyle" },
          textStyle: { $ref: "TextStyle" },
        },
        type: "object",
      },
      ParagraphStyle: {
        properties: {
          alignment: {
            enum: [
              "ALIGNMENT_UNSPECIFIED",
              "START",
              "CENTER",
              "END",
              "JUSTIFIED",
            ],
            type: "string",
          },
          avoidWidowAndOrphan: { type: "boolean" },
          borderBetween: { $ref: "ParagraphBorder" },
          borderBottom: { $ref: "ParagraphBorder" },
          borderLeft: { $ref: "ParagraphBorder" },
          borderRight: { $ref: "ParagraphBorder" },
          borderTop: { $ref: "ParagraphBorder" },
          direction: {
            enum: [
              "CONTENT_DIRECTION_UNSPECIFIED",
              "LEFT_TO_RIGHT",
              "RIGHT_TO_LEFT",
            ],
            type: "string",
          },
          headingId: { type: "string" },
          indentEnd: { $ref: "Dimension" },
          indentFirstLine: { $ref: "Dimension" },
          indentStart: { $ref: "Dimension" },
          keepLinesTogether: { type: "boolean" },
          keepWithNext: { type: "boolean" },
          lineSpacing: { format: "float", type: "number" },
          namedStyleType: {
            enum: [
              "NAMED_STYLE_TYPE_UNSPECIFIED",
              "NORMAL_TEXT",
              "TITLE",
              "SUBTITLE",
              "HEADING_1",
              "HEADING_2",
              "HEADING_3",
              "HEADING_4",
              "HEADING_5",
              "HEADING_6",
            ],
            type: "string",
          },
          pageBreakBefore: { type: "boolean" },
          shading: { $ref: "Shading" },
          spaceAbove: { $ref: "Dimension" },
          spaceBelow: { $ref: "Dimension" },
          spacingMode: {
            enum: [
              "SPACING_MODE_UNSPECIFIED",
              "NEVER_COLLAPSE",
              "COLLAPSE_LISTS",
            ],
            type: "string",
          },
          tabStops: { items: { $ref: "TabStop" }, type: "array" },
        },
        type: "object",
      },
      ParagraphBorder: {
        properties: {
          color: { $ref: "OptionalColor" },
          dashStyle: {
            enum: ["DASH_STYLE_UNSPECIFIED", "SOLID", "DOT", "DASH"],
            type: "string",
          },
          padding: { $ref: "Dimension" },
          width: { $ref: "Dimension" },
        },
        type: "object",
      },
      Shading: {
        properties: { backgroundColor: { $ref: "OptionalColor" } },
        type: "object",
      },
      TabStop: {
        properties: {
          alignment: {
            enum: ["TAB_STOP_ALIGNMENT_UNSPECIFIED", "START", "CENTER", "END"],
            type: "string",
          },
          offset: { $ref: "Dimension" },
        },
        type: "object",
      },
      TextStyle: {
        properties: {
          backgroundColor: { $ref: "OptionalColor" },
          baselineOffset: {
            enum: [
              "BASELINE_OFFSET_UNSPECIFIED",
              "NONE",
              "SUPERSCRIPT",
              "SUBSCRIPT",
            ],
            type: "string",
          },
          bold: { type: "boolean" },
          fontSize: { $ref: "Dimension" },
          foregroundColor: { $ref: "OptionalColor" },
          italic: { type: "boolean" },
          link: { $ref: "Link" },
          smallCaps: { type: "boolean" },
          strikethrough: { type: "boolean" },
          underline: { type: "boolean" },
          weightedFontFamily: { $ref: "WeightedFontFamily" },
        },
        type: "object",
      },
      Link: {
        properties: {
          bookmark: { $ref: "BookmarkLink" },
          bookmarkId: { type: "string" },
          heading: { $ref: "HeadingLink" },
          headingId: { type: "string" },
          tabId: { type: "string" },
          url: { type: "string" },
        },
        type: "object",
      },
      BookmarkLink: {
        properties: { tabId: { type: "string" } },
        type: "object",
      },
      HeadingLink: {
        properties: { tabId: { type: "string" } },
        type: "object",
      },
      WeightedFontFamily: {
        properties: {
          fontFamily: { type: "string" },
          weight: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      UpdateParagraphStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          paragraphStyle: { $ref: "ParagraphStyle" },
          range: { $ref: "Range" },
        },
        type: "object",
      },
      UpdateSectionStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          range: { $ref: "Range" },
          sectionStyle: { $ref: "SectionStyle" },
        },
        type: "object",
      },
      SectionStyle: {
        properties: {
          columnProperties: {
            items: { $ref: "SectionColumnProperties" },
            type: "array",
          },
          columnSeparatorStyle: {
            enum: [
              "COLUMN_SEPARATOR_STYLE_UNSPECIFIED",
              "NONE",
              "BETWEEN_EACH_COLUMN",
            ],
            type: "string",
          },
          contentDirection: {
            enum: [
              "CONTENT_DIRECTION_UNSPECIFIED",
              "LEFT_TO_RIGHT",
              "RIGHT_TO_LEFT",
            ],
            type: "string",
          },
          defaultFooterId: { type: "string" },
          defaultHeaderId: { type: "string" },
          evenPageFooterId: { type: "string" },
          evenPageHeaderId: { type: "string" },
          firstPageFooterId: { type: "string" },
          firstPageHeaderId: { type: "string" },
          flipPageOrientation: { type: "boolean" },
          marginBottom: { $ref: "Dimension" },
          marginFooter: { $ref: "Dimension" },
          marginHeader: { $ref: "Dimension" },
          marginLeft: { $ref: "Dimension" },
          marginRight: { $ref: "Dimension" },
          marginTop: { $ref: "Dimension" },
          pageNumberStart: { format: "int32", type: "integer" },
          sectionType: {
            enum: ["SECTION_TYPE_UNSPECIFIED", "CONTINUOUS", "NEXT_PAGE"],
            type: "string",
          },
          useFirstPageHeaderFooter: { type: "boolean" },
        },
        type: "object",
      },
      SectionColumnProperties: {
        properties: {
          paddingEnd: { $ref: "Dimension" },
          width: { $ref: "Dimension" },
        },
        type: "object",
      },
      UpdateTableCellStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          tableCellStyle: { $ref: "TableCellStyle" },
          tableRange: { $ref: "TableRange" },
          tableStartLocation: { $ref: "Location" },
        },
        type: "object",
      },
      TableCellStyle: {
        properties: {
          backgroundColor: { $ref: "OptionalColor" },
          borderBottom: { $ref: "TableCellBorder" },
          borderLeft: { $ref: "TableCellBorder" },
          borderRight: { $ref: "TableCellBorder" },
          borderTop: { $ref: "TableCellBorder" },
          columnSpan: { format: "int32", type: "integer" },
          contentAlignment: {
            enum: [
              "CONTENT_ALIGNMENT_UNSPECIFIED",
              "CONTENT_ALIGNMENT_UNSUPPORTED",
              "TOP",
              "MIDDLE",
              "BOTTOM",
            ],
            type: "string",
          },
          paddingBottom: { $ref: "Dimension" },
          paddingLeft: { $ref: "Dimension" },
          paddingRight: { $ref: "Dimension" },
          paddingTop: { $ref: "Dimension" },
          rowSpan: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      TableCellBorder: {
        properties: {
          color: { $ref: "OptionalColor" },
          dashStyle: {
            enum: ["DASH_STYLE_UNSPECIFIED", "SOLID", "DOT", "DASH"],
            type: "string",
          },
          width: { $ref: "Dimension" },
        },
        type: "object",
      },
      UpdateTableColumnPropertiesRequest: {
        properties: {
          columnIndices: {
            items: { format: "int32", type: "integer" },
            type: "array",
          },
          fields: { format: "google-fieldmask", type: "string" },
          tableColumnProperties: { $ref: "TableColumnProperties" },
          tableStartLocation: { $ref: "Location" },
        },
        type: "object",
      },
      TableColumnProperties: {
        properties: {
          width: { $ref: "Dimension" },
          widthType: {
            enum: [
              "WIDTH_TYPE_UNSPECIFIED",
              "EVENLY_DISTRIBUTED",
              "FIXED_WIDTH",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      UpdateTableRowStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          rowIndices: {
            items: { format: "int32", type: "integer" },
            type: "array",
          },
          tableRowStyle: { $ref: "TableRowStyle" },
          tableStartLocation: { $ref: "Location" },
        },
        type: "object",
      },
      TableRowStyle: {
        properties: {
          minRowHeight: { $ref: "Dimension" },
          preventOverflow: { type: "boolean" },
          tableHeader: { type: "boolean" },
        },
        type: "object",
      },
      UpdateTextStyleRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          range: { $ref: "Range" },
          textStyle: { $ref: "TextStyle" },
        },
        type: "object",
      },
      WriteControl: {
        properties: {
          requiredRevisionId: { type: "string" },
          targetRevisionId: { type: "string" },
        },
        type: "object",
      },
    },
  },
  slides: {
    root: "BatchUpdatePresentationRequest",
    revision: "20260408",
    schemas: {
      BatchUpdatePresentationRequest: {
        properties: {
          requests: { items: { $ref: "Request" }, type: "array" },
          writeControl: { $ref: "WriteControl" },
        },
        type: "object",
      },
      Request: {
        properties: {
          createImage: { $ref: "CreateImageRequest" },
          createLine: { $ref: "CreateLineRequest" },
          createParagraphBullets: { $ref: "CreateParagraphBulletsRequest" },
          createShape: { $ref: "CreateShapeRequest" },
          createSheetsChart: { $ref: "CreateSheetsChartRequest" },
          createSlide: { $ref: "CreateSlideRequest" },
          createTable: { $ref: "CreateTableRequest" },
          createVideo: { $ref: "CreateVideoRequest" },
          deleteObject: { $ref: "DeleteObjectRequest" },
          deleteParagraphBullets: { $ref: "DeleteParagraphBulletsRequest" },
          deleteTableColumn: { $ref: "DeleteTableColumnRequest" },
          deleteTableRow: { $ref: "DeleteTableRowRequest" },
          deleteText: { $ref: "DeleteTextRequest" },
          duplicateObject: { $ref: "DuplicateObjectRequest" },
          groupObjects: { $ref: "GroupObjectsRequest" },
          insertTableColumns: { $ref: "InsertTableColumnsRequest" },
          insertTableRows: { $ref: "InsertTableRowsRequest" },
          insertText: { $ref: "InsertTextRequest" },
          mergeTableCells: { $ref: "MergeTableCellsRequest" },
          refreshSheetsChart: { $ref: "RefreshSheetsChartRequest" },
          replaceAllShapesWithImage: {
            $ref: "ReplaceAllShapesWithImageRequest",
          },
          replaceAllShapesWithSheetsChart: {
            $ref: "ReplaceAllShapesWithSheetsChartRequest",
          },
          replaceAllText: { $ref: "ReplaceAllTextRequest" },
          replaceImage: { $ref: "ReplaceImageRequest" },
          rerouteLine: { $ref: "RerouteLineRequest" },
          ungroupObjects: { $ref: "UngroupObjectsRequest" },
          unmergeTableCells: { $ref: "UnmergeTableCellsRequest" },
          updateImageProperties: { $ref: "UpdateImagePropertiesRequest" },
          updateLineCategory: { $ref: "UpdateLineCategoryRequest" },
          updateLineProperties: { $ref: "UpdateLinePropertiesRequest" },
          updatePageElementAltText: { $ref: "UpdatePageElementAltTextRequest" },
          updatePageElementTransform: {
            $ref: "UpdatePageElementTransformRequest",
          },
          updatePageElementsZOrder: { $ref: "UpdatePageElementsZOrderRequest" },
          updatePageProperties: { $ref: "UpdatePagePropertiesRequest" },
          updateParagraphStyle: { $ref: "UpdateParagraphStyleRequest" },
          updateShapeProperties: { $ref: "UpdateShapePropertiesRequest" },
          updateSlideProperties: { $ref: "UpdateSlidePropertiesRequest" },
          updateSlidesPosition: { $ref: "UpdateSlidesPositionRequest" },
          updateTableBorderProperties: {
            $ref: "UpdateTableBorderPropertiesRequest",
          },
          updateTableCellProperties: {
            $ref: "UpdateTableCellPropertiesRequest",
          },
          updateTableColumnProperties: {
            $ref: "UpdateTableColumnPropertiesRequest",
          },
          updateTableRowProperties: { $ref: "UpdateTableRowPropertiesRequest" },
          updateTextStyle: { $ref: "UpdateTextStyleRequest" },
          updateVideoProperties: { $ref: "UpdateVideoPropertiesRequest" },
        },
        type: "object",
      },
      CreateImageRequest: {
        properties: {
          elementProperties: { $ref: "PageElementProperties" },
          objectId: { type: "string" },
          url: { type: "string" },
        },
        type: "object",
      },
      PageElementProperties: {
        properties: {
          pageObjectId: { type: "string" },
          size: { $ref: "Size" },
          transform: { $ref: "AffineTransform" },
        },
        type: "object",
      },
      Size: {
        properties: {
          height: { $ref: "Dimension" },
          width: { $ref: "Dimension" },
        },
        type: "object",
      },
      Dimension: {
        properties: {
          magnitude: { format: "double", type: "number" },
          unit: { enum: ["UNIT_UNSPECIFIED", "EMU", "PT"], type: "string" },
        },
        type: "object",
      },
      AffineTransform: {
        properties: {
          scaleX: { format: "double", type: "number" },
          scaleY: { format: "double", type: "number" },
          shearX: { format: "double", type: "number" },
          shearY: { format: "double", type: "number" },
          translateX: { format: "double", type: "number" },
          translateY: { format: "double", type: "number" },
          unit: { enum: ["UNIT_UNSPECIFIED", "EMU", "PT"], type: "string" },
        },
        type: "object",
      },
      CreateLineRequest: {
        properties: {
          category: {
            enum: ["LINE_CATEGORY_UNSPECIFIED", "STRAIGHT", "BENT", "CURVED"],
            type: "string",
          },
          elementProperties: { $ref: "PageElementProperties" },
          lineCategory: {
            deprecated: true,
            enum: ["STRAIGHT", "BENT", "CURVED"],
            type: "string",
          },
          objectId: { type: "string" },
        },
        type: "object",
      },
      CreateParagraphBulletsRequest: {
        properties: {
          bulletPreset: {
            enum: [
              "BULLET_DISC_CIRCLE_SQUARE",
              "BULLET_DIAMONDX_ARROW3D_SQUARE",
              "BULLET_CHECKBOX",
              "BULLET_ARROW_DIAMOND_DISC",
              "BULLET_STAR_CIRCLE_SQUARE",
              "BULLET_ARROW3D_CIRCLE_SQUARE",
              "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
              "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE",
              "BULLET_DIAMOND_CIRCLE_SQUARE",
              "NUMBERED_DIGIT_ALPHA_ROMAN",
              "NUMBERED_DIGIT_ALPHA_ROMAN_PARENS",
              "NUMBERED_DIGIT_NESTED",
              "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
              "NUMBERED_UPPERROMAN_UPPERALPHA_DIGIT",
              "NUMBERED_ZERODIGIT_ALPHA_ROMAN",
            ],
            type: "string",
          },
          cellLocation: { $ref: "TableCellLocation" },
          objectId: { type: "string" },
          textRange: { $ref: "Range" },
        },
        type: "object",
      },
      TableCellLocation: {
        properties: {
          columnIndex: { format: "int32", type: "integer" },
          rowIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      Range: {
        properties: {
          endIndex: { format: "int32", type: "integer" },
          startIndex: { format: "int32", type: "integer" },
          type: {
            enum: [
              "RANGE_TYPE_UNSPECIFIED",
              "FIXED_RANGE",
              "FROM_START_INDEX",
              "ALL",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      CreateShapeRequest: {
        properties: {
          elementProperties: { $ref: "PageElementProperties" },
          objectId: { type: "string" },
          shapeType: {
            enum: [
              "TYPE_UNSPECIFIED",
              "TEXT_BOX",
              "RECTANGLE",
              "ROUND_RECTANGLE",
              "ELLIPSE",
              "ARC",
              "BENT_ARROW",
              "BENT_UP_ARROW",
              "BEVEL",
              "BLOCK_ARC",
              "BRACE_PAIR",
              "BRACKET_PAIR",
              "CAN",
              "CHEVRON",
              "CHORD",
              "CLOUD",
              "CORNER",
              "CUBE",
              "CURVED_DOWN_ARROW",
              "CURVED_LEFT_ARROW",
              "CURVED_RIGHT_ARROW",
              "CURVED_UP_ARROW",
              "DECAGON",
              "DIAGONAL_STRIPE",
              "DIAMOND",
              "DODECAGON",
              "DONUT",
              "DOUBLE_WAVE",
              "DOWN_ARROW",
              "DOWN_ARROW_CALLOUT",
              "FOLDED_CORNER",
              "FRAME",
              "HALF_FRAME",
              "HEART",
              "HEPTAGON",
              "HEXAGON",
              "HOME_PLATE",
              "HORIZONTAL_SCROLL",
              "IRREGULAR_SEAL_1",
              "IRREGULAR_SEAL_2",
              "LEFT_ARROW",
              "LEFT_ARROW_CALLOUT",
              "LEFT_BRACE",
              "LEFT_BRACKET",
              "LEFT_RIGHT_ARROW",
              "LEFT_RIGHT_ARROW_CALLOUT",
              "LEFT_RIGHT_UP_ARROW",
              "LEFT_UP_ARROW",
              "LIGHTNING_BOLT",
              "MATH_DIVIDE",
              "MATH_EQUAL",
              "MATH_MINUS",
              "MATH_MULTIPLY",
              "MATH_NOT_EQUAL",
              "MATH_PLUS",
              "MOON",
              "NO_SMOKING",
              "NOTCHED_RIGHT_ARROW",
              "OCTAGON",
              "PARALLELOGRAM",
              "PENTAGON",
              "PIE",
              "PLAQUE",
              "PLUS",
              "QUAD_ARROW",
              "QUAD_ARROW_CALLOUT",
              "RIBBON",
              "RIBBON_2",
              "RIGHT_ARROW",
              "RIGHT_ARROW_CALLOUT",
              "RIGHT_BRACE",
              "RIGHT_BRACKET",
              "ROUND_1_RECTANGLE",
              "ROUND_2_DIAGONAL_RECTANGLE",
              "ROUND_2_SAME_RECTANGLE",
              "RIGHT_TRIANGLE",
              "SMILEY_FACE",
              "SNIP_1_RECTANGLE",
              "SNIP_2_DIAGONAL_RECTANGLE",
              "SNIP_2_SAME_RECTANGLE",
              "SNIP_ROUND_RECTANGLE",
              "STAR_10",
              "STAR_12",
              "STAR_16",
              "STAR_24",
              "STAR_32",
              "STAR_4",
              "STAR_5",
              "STAR_6",
              "STAR_7",
              "STAR_8",
              "STRIPED_RIGHT_ARROW",
              "SUN",
              "TRAPEZOID",
              "TRIANGLE",
              "UP_ARROW",
              "UP_ARROW_CALLOUT",
              "UP_DOWN_ARROW",
              "UTURN_ARROW",
              "VERTICAL_SCROLL",
              "WAVE",
              "WEDGE_ELLIPSE_CALLOUT",
              "WEDGE_RECTANGLE_CALLOUT",
              "WEDGE_ROUND_RECTANGLE_CALLOUT",
              "FLOW_CHART_ALTERNATE_PROCESS",
              "FLOW_CHART_COLLATE",
              "FLOW_CHART_CONNECTOR",
              "FLOW_CHART_DECISION",
              "FLOW_CHART_DELAY",
              "FLOW_CHART_DISPLAY",
              "FLOW_CHART_DOCUMENT",
              "FLOW_CHART_EXTRACT",
              "FLOW_CHART_INPUT_OUTPUT",
              "FLOW_CHART_INTERNAL_STORAGE",
              "FLOW_CHART_MAGNETIC_DISK",
              "FLOW_CHART_MAGNETIC_DRUM",
              "FLOW_CHART_MAGNETIC_TAPE",
              "FLOW_CHART_MANUAL_INPUT",
              "FLOW_CHART_MANUAL_OPERATION",
              "FLOW_CHART_MERGE",
              "FLOW_CHART_MULTIDOCUMENT",
              "FLOW_CHART_OFFLINE_STORAGE",
              "FLOW_CHART_OFFPAGE_CONNECTOR",
              "FLOW_CHART_ONLINE_STORAGE",
              "FLOW_CHART_OR",
              "FLOW_CHART_PREDEFINED_PROCESS",
              "FLOW_CHART_PREPARATION",
              "FLOW_CHART_PROCESS",
              "FLOW_CHART_PUNCHED_CARD",
              "FLOW_CHART_PUNCHED_TAPE",
              "FLOW_CHART_SORT",
              "FLOW_CHART_SUMMING_JUNCTION",
              "FLOW_CHART_TERMINATOR",
              "ARROW_EAST",
              "ARROW_NORTH_EAST",
              "ARROW_NORTH",
              "SPEECH",
              "STARBURST",
              "TEARDROP",
              "ELLIPSE_RIBBON",
              "ELLIPSE_RIBBON_2",
              "CLOUD_CALLOUT",
              "CUSTOM",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      CreateSheetsChartRequest: {
        properties: {
          chartId: { format: "int32", type: "integer" },
          elementProperties: { $ref: "PageElementProperties" },
          linkingMode: { enum: ["NOT_LINKED_IMAGE", "LINKED"], type: "string" },
          objectId: { type: "string" },
          spreadsheetId: { type: "string" },
        },
        type: "object",
      },
      CreateSlideRequest: {
        properties: {
          insertionIndex: { format: "int32", type: "integer" },
          objectId: { type: "string" },
          placeholderIdMappings: {
            items: { $ref: "LayoutPlaceholderIdMapping" },
            type: "array",
          },
          slideLayoutReference: { $ref: "LayoutReference" },
        },
        type: "object",
      },
      LayoutPlaceholderIdMapping: {
        properties: {
          layoutPlaceholder: { $ref: "Placeholder" },
          layoutPlaceholderObjectId: { type: "string" },
          objectId: { type: "string" },
        },
        type: "object",
      },
      Placeholder: {
        properties: {
          index: { format: "int32", type: "integer" },
          parentObjectId: { type: "string" },
          type: {
            enum: [
              "NONE",
              "BODY",
              "CHART",
              "CLIP_ART",
              "CENTERED_TITLE",
              "DIAGRAM",
              "DATE_AND_TIME",
              "FOOTER",
              "HEADER",
              "MEDIA",
              "OBJECT",
              "PICTURE",
              "SLIDE_NUMBER",
              "SUBTITLE",
              "TABLE",
              "TITLE",
              "SLIDE_IMAGE",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      LayoutReference: {
        properties: {
          layoutId: { type: "string" },
          predefinedLayout: {
            enum: [
              "PREDEFINED_LAYOUT_UNSPECIFIED",
              "BLANK",
              "CAPTION_ONLY",
              "TITLE",
              "TITLE_AND_BODY",
              "TITLE_AND_TWO_COLUMNS",
              "TITLE_ONLY",
              "SECTION_HEADER",
              "SECTION_TITLE_AND_DESCRIPTION",
              "ONE_COLUMN_TEXT",
              "MAIN_POINT",
              "BIG_NUMBER",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      CreateTableRequest: {
        properties: {
          columns: { format: "int32", type: "integer" },
          elementProperties: { $ref: "PageElementProperties" },
          objectId: { type: "string" },
          rows: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      CreateVideoRequest: {
        properties: {
          elementProperties: { $ref: "PageElementProperties" },
          objectId: { type: "string" },
          source: {
            enum: ["SOURCE_UNSPECIFIED", "YOUTUBE", "DRIVE"],
            type: "string",
          },
        },
        type: "object",
      },
      DeleteObjectRequest: {
        properties: { objectId: { type: "string" } },
        type: "object",
      },
      DeleteParagraphBulletsRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          objectId: { type: "string" },
          textRange: { $ref: "Range" },
        },
        type: "object",
      },
      DeleteTableColumnRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          tableObjectId: { type: "string" },
        },
        type: "object",
      },
      DeleteTableRowRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          tableObjectId: { type: "string" },
        },
        type: "object",
      },
      DeleteTextRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          objectId: { type: "string" },
          textRange: { $ref: "Range" },
        },
        type: "object",
      },
      DuplicateObjectRequest: {
        properties: {
          objectId: { type: "string" },
          objectIds: {
            additionalProperties: { type: "string" },
            type: "object",
          },
        },
        type: "object",
      },
      GroupObjectsRequest: {
        properties: {
          childrenObjectIds: { items: { type: "string" }, type: "array" },
          groupObjectId: { type: "string" },
        },
        type: "object",
      },
      InsertTableColumnsRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          insertRight: { type: "boolean" },
          number: { format: "int32", type: "integer" },
          tableObjectId: { type: "string" },
        },
        type: "object",
      },
      InsertTableRowsRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          insertBelow: { type: "boolean" },
          number: { format: "int32", type: "integer" },
          tableObjectId: { type: "string" },
        },
        type: "object",
      },
      InsertTextRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          insertionIndex: { format: "int32", type: "integer" },
          objectId: { type: "string" },
          text: { type: "string" },
        },
        type: "object",
      },
      MergeTableCellsRequest: {
        properties: {
          objectId: { type: "string" },
          tableRange: { $ref: "TableRange" },
        },
        type: "object",
      },
      TableRange: {
        properties: {
          columnSpan: { format: "int32", type: "integer" },
          location: { $ref: "TableCellLocation" },
          rowSpan: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      RefreshSheetsChartRequest: {
        properties: { objectId: { type: "string" } },
        type: "object",
      },
      ReplaceAllShapesWithImageRequest: {
        properties: {
          containsText: { $ref: "SubstringMatchCriteria" },
          imageReplaceMethod: {
            enum: [
              "IMAGE_REPLACE_METHOD_UNSPECIFIED",
              "CENTER_INSIDE",
              "CENTER_CROP",
            ],
            type: "string",
          },
          imageUrl: { type: "string" },
          pageObjectIds: { items: { type: "string" }, type: "array" },
          replaceMethod: {
            deprecated: true,
            enum: ["CENTER_INSIDE", "CENTER_CROP"],
            type: "string",
          },
        },
        type: "object",
      },
      SubstringMatchCriteria: {
        properties: {
          matchCase: { type: "boolean" },
          searchByRegex: { type: "boolean" },
          text: { type: "string" },
        },
        type: "object",
      },
      ReplaceAllShapesWithSheetsChartRequest: {
        properties: {
          chartId: { format: "int32", type: "integer" },
          containsText: { $ref: "SubstringMatchCriteria" },
          linkingMode: { enum: ["NOT_LINKED_IMAGE", "LINKED"], type: "string" },
          pageObjectIds: { items: { type: "string" }, type: "array" },
          spreadsheetId: { type: "string" },
        },
        type: "object",
      },
      ReplaceAllTextRequest: {
        properties: {
          containsText: { $ref: "SubstringMatchCriteria" },
          pageObjectIds: { items: { type: "string" }, type: "array" },
          replaceText: { type: "string" },
        },
        type: "object",
      },
      ReplaceImageRequest: {
        properties: {
          imageObjectId: { type: "string" },
          imageReplaceMethod: {
            enum: [
              "IMAGE_REPLACE_METHOD_UNSPECIFIED",
              "CENTER_INSIDE",
              "CENTER_CROP",
            ],
            type: "string",
          },
          url: { type: "string" },
        },
        type: "object",
      },
      RerouteLineRequest: {
        properties: { objectId: { type: "string" } },
        type: "object",
      },
      UngroupObjectsRequest: {
        properties: { objectIds: { items: { type: "string" }, type: "array" } },
        type: "object",
      },
      UnmergeTableCellsRequest: {
        properties: {
          objectId: { type: "string" },
          tableRange: { $ref: "TableRange" },
        },
        type: "object",
      },
      UpdateImagePropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          imageProperties: { $ref: "ImageProperties" },
          objectId: { type: "string" },
        },
        type: "object",
      },
      ImageProperties: {
        properties: {
          brightness: { format: "float", type: "number" },
          contrast: { format: "float", type: "number" },
          cropProperties: { $ref: "CropProperties" },
          link: { $ref: "Link" },
          outline: { $ref: "Outline" },
          recolor: { $ref: "Recolor" },
          shadow: { $ref: "Shadow" },
          transparency: { format: "float", type: "number" },
        },
        type: "object",
      },
      CropProperties: {
        properties: {
          angle: { format: "float", type: "number" },
          bottomOffset: { format: "float", type: "number" },
          leftOffset: { format: "float", type: "number" },
          rightOffset: { format: "float", type: "number" },
          topOffset: { format: "float", type: "number" },
        },
        type: "object",
      },
      Link: {
        properties: {
          pageObjectId: { type: "string" },
          relativeLink: {
            enum: [
              "RELATIVE_SLIDE_LINK_UNSPECIFIED",
              "NEXT_SLIDE",
              "PREVIOUS_SLIDE",
              "FIRST_SLIDE",
              "LAST_SLIDE",
            ],
            type: "string",
          },
          slideIndex: { format: "int32", type: "integer" },
          url: { type: "string" },
        },
        type: "object",
      },
      Outline: {
        properties: {
          dashStyle: {
            enum: [
              "DASH_STYLE_UNSPECIFIED",
              "SOLID",
              "DOT",
              "DASH",
              "DASH_DOT",
              "LONG_DASH",
              "LONG_DASH_DOT",
            ],
            type: "string",
          },
          outlineFill: { $ref: "OutlineFill" },
          propertyState: {
            enum: ["RENDERED", "NOT_RENDERED", "INHERIT"],
            type: "string",
          },
          weight: { $ref: "Dimension" },
        },
        type: "object",
      },
      OutlineFill: {
        properties: { solidFill: { $ref: "SolidFill" } },
        type: "object",
      },
      SolidFill: {
        properties: {
          alpha: { format: "float", type: "number" },
          color: { $ref: "OpaqueColor" },
        },
        type: "object",
      },
      OpaqueColor: {
        properties: {
          rgbColor: { $ref: "RgbColor" },
          themeColor: {
            enum: [
              "THEME_COLOR_TYPE_UNSPECIFIED",
              "DARK1",
              "LIGHT1",
              "DARK2",
              "LIGHT2",
              "ACCENT1",
              "ACCENT2",
              "ACCENT3",
              "ACCENT4",
              "ACCENT5",
              "ACCENT6",
              "HYPERLINK",
              "FOLLOWED_HYPERLINK",
              "TEXT1",
              "BACKGROUND1",
              "TEXT2",
              "BACKGROUND2",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      RgbColor: {
        properties: {
          blue: { format: "float", type: "number" },
          green: { format: "float", type: "number" },
          red: { format: "float", type: "number" },
        },
        type: "object",
      },
      Recolor: {
        properties: {
          name: {
            enum: [
              "NONE",
              "LIGHT1",
              "LIGHT2",
              "LIGHT3",
              "LIGHT4",
              "LIGHT5",
              "LIGHT6",
              "LIGHT7",
              "LIGHT8",
              "LIGHT9",
              "LIGHT10",
              "DARK1",
              "DARK2",
              "DARK3",
              "DARK4",
              "DARK5",
              "DARK6",
              "DARK7",
              "DARK8",
              "DARK9",
              "DARK10",
              "GRAYSCALE",
              "NEGATIVE",
              "SEPIA",
              "CUSTOM",
            ],
            type: "string",
          },
          recolorStops: { items: { $ref: "ColorStop" }, type: "array" },
        },
        type: "object",
      },
      ColorStop: {
        properties: {
          alpha: { format: "float", type: "number" },
          color: { $ref: "OpaqueColor" },
          position: { format: "float", type: "number" },
        },
        type: "object",
      },
      Shadow: {
        properties: {
          alignment: {
            enum: [
              "RECTANGLE_POSITION_UNSPECIFIED",
              "TOP_LEFT",
              "TOP_CENTER",
              "TOP_RIGHT",
              "LEFT_CENTER",
              "CENTER",
              "RIGHT_CENTER",
              "BOTTOM_LEFT",
              "BOTTOM_CENTER",
              "BOTTOM_RIGHT",
            ],
            type: "string",
          },
          alpha: { format: "float", type: "number" },
          blurRadius: { $ref: "Dimension" },
          color: { $ref: "OpaqueColor" },
          propertyState: {
            enum: ["RENDERED", "NOT_RENDERED", "INHERIT"],
            type: "string",
          },
          rotateWithShape: { type: "boolean" },
          transform: { $ref: "AffineTransform" },
          type: { enum: ["SHADOW_TYPE_UNSPECIFIED", "OUTER"], type: "string" },
        },
        type: "object",
      },
      UpdateLineCategoryRequest: {
        properties: {
          lineCategory: {
            enum: ["LINE_CATEGORY_UNSPECIFIED", "STRAIGHT", "BENT", "CURVED"],
            type: "string",
          },
          objectId: { type: "string" },
        },
        type: "object",
      },
      UpdateLinePropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          lineProperties: { $ref: "LineProperties" },
          objectId: { type: "string" },
        },
        type: "object",
      },
      LineProperties: {
        properties: {
          dashStyle: {
            enum: [
              "DASH_STYLE_UNSPECIFIED",
              "SOLID",
              "DOT",
              "DASH",
              "DASH_DOT",
              "LONG_DASH",
              "LONG_DASH_DOT",
            ],
            type: "string",
          },
          endArrow: {
            enum: [
              "ARROW_STYLE_UNSPECIFIED",
              "NONE",
              "STEALTH_ARROW",
              "FILL_ARROW",
              "FILL_CIRCLE",
              "FILL_SQUARE",
              "FILL_DIAMOND",
              "OPEN_ARROW",
              "OPEN_CIRCLE",
              "OPEN_SQUARE",
              "OPEN_DIAMOND",
            ],
            type: "string",
          },
          endConnection: { $ref: "LineConnection" },
          lineFill: { $ref: "LineFill" },
          link: { $ref: "Link" },
          startArrow: {
            enum: [
              "ARROW_STYLE_UNSPECIFIED",
              "NONE",
              "STEALTH_ARROW",
              "FILL_ARROW",
              "FILL_CIRCLE",
              "FILL_SQUARE",
              "FILL_DIAMOND",
              "OPEN_ARROW",
              "OPEN_CIRCLE",
              "OPEN_SQUARE",
              "OPEN_DIAMOND",
            ],
            type: "string",
          },
          startConnection: { $ref: "LineConnection" },
          weight: { $ref: "Dimension" },
        },
        type: "object",
      },
      LineConnection: {
        properties: {
          connectedObjectId: { type: "string" },
          connectionSiteIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      LineFill: {
        properties: { solidFill: { $ref: "SolidFill" } },
        type: "object",
      },
      UpdatePageElementAltTextRequest: {
        properties: { objectId: { type: "string" }, title: { type: "string" } },
        type: "object",
      },
      UpdatePageElementTransformRequest: {
        properties: {
          applyMode: {
            enum: ["APPLY_MODE_UNSPECIFIED", "RELATIVE", "ABSOLUTE"],
            type: "string",
          },
          objectId: { type: "string" },
          transform: { $ref: "AffineTransform" },
        },
        type: "object",
      },
      UpdatePageElementsZOrderRequest: {
        properties: {
          operation: {
            enum: [
              "Z_ORDER_OPERATION_UNSPECIFIED",
              "BRING_TO_FRONT",
              "BRING_FORWARD",
              "SEND_BACKWARD",
              "SEND_TO_BACK",
            ],
            type: "string",
          },
          pageElementObjectIds: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      UpdatePagePropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          pageProperties: { $ref: "PageProperties" },
        },
        type: "object",
      },
      PageProperties: {
        properties: {
          colorScheme: { $ref: "ColorScheme" },
          pageBackgroundFill: { $ref: "PageBackgroundFill" },
        },
        type: "object",
      },
      ColorScheme: {
        properties: {
          colors: { items: { $ref: "ThemeColorPair" }, type: "array" },
        },
        type: "object",
      },
      ThemeColorPair: {
        properties: {
          color: { $ref: "RgbColor" },
          type: {
            enum: [
              "THEME_COLOR_TYPE_UNSPECIFIED",
              "DARK1",
              "LIGHT1",
              "DARK2",
              "LIGHT2",
              "ACCENT1",
              "ACCENT2",
              "ACCENT3",
              "ACCENT4",
              "ACCENT5",
              "ACCENT6",
              "HYPERLINK",
              "FOLLOWED_HYPERLINK",
              "TEXT1",
              "BACKGROUND1",
              "TEXT2",
              "BACKGROUND2",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      PageBackgroundFill: {
        properties: {
          propertyState: {
            enum: ["RENDERED", "NOT_RENDERED", "INHERIT"],
            type: "string",
          },
          solidFill: { $ref: "SolidFill" },
          stretchedPictureFill: { $ref: "StretchedPictureFill" },
        },
        type: "object",
      },
      StretchedPictureFill: {
        properties: { contentUrl: { type: "string" }, size: { $ref: "Size" } },
        type: "object",
      },
      UpdateParagraphStyleRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          style: { $ref: "ParagraphStyle" },
          textRange: { $ref: "Range" },
        },
        type: "object",
      },
      ParagraphStyle: {
        properties: {
          alignment: {
            enum: [
              "ALIGNMENT_UNSPECIFIED",
              "START",
              "CENTER",
              "END",
              "JUSTIFIED",
            ],
            type: "string",
          },
          direction: {
            enum: [
              "TEXT_DIRECTION_UNSPECIFIED",
              "LEFT_TO_RIGHT",
              "RIGHT_TO_LEFT",
            ],
            type: "string",
          },
          indentEnd: { $ref: "Dimension" },
          indentFirstLine: { $ref: "Dimension" },
          indentStart: { $ref: "Dimension" },
          lineSpacing: { format: "float", type: "number" },
          spaceAbove: { $ref: "Dimension" },
          spaceBelow: { $ref: "Dimension" },
          spacingMode: {
            enum: [
              "SPACING_MODE_UNSPECIFIED",
              "NEVER_COLLAPSE",
              "COLLAPSE_LISTS",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      UpdateShapePropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          shapeProperties: { $ref: "ShapeProperties" },
        },
        type: "object",
      },
      ShapeProperties: {
        properties: {
          autofit: { $ref: "Autofit" },
          contentAlignment: {
            enum: [
              "CONTENT_ALIGNMENT_UNSPECIFIED",
              "CONTENT_ALIGNMENT_UNSUPPORTED",
              "TOP",
              "MIDDLE",
              "BOTTOM",
            ],
            type: "string",
          },
          link: { $ref: "Link" },
          outline: { $ref: "Outline" },
          shadow: { $ref: "Shadow" },
          shapeBackgroundFill: { $ref: "ShapeBackgroundFill" },
        },
        type: "object",
      },
      Autofit: {
        properties: {
          autofitType: {
            enum: [
              "AUTOFIT_TYPE_UNSPECIFIED",
              "NONE",
              "TEXT_AUTOFIT",
              "SHAPE_AUTOFIT",
            ],
            type: "string",
          },
          fontScale: { format: "float", type: "number" },
          lineSpacingReduction: { format: "float", type: "number" },
        },
        type: "object",
      },
      ShapeBackgroundFill: {
        properties: {
          propertyState: {
            enum: ["RENDERED", "NOT_RENDERED", "INHERIT"],
            type: "string",
          },
          solidFill: { $ref: "SolidFill" },
        },
        type: "object",
      },
      UpdateSlidePropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          slideProperties: { $ref: "SlideProperties" },
        },
        type: "object",
      },
      SlideProperties: {
        properties: {
          isSkipped: { type: "boolean" },
          layoutObjectId: { type: "string" },
          masterObjectId: { type: "string" },
          notesPage: { $ref: "Page" },
        },
        type: "object",
      },
      Page: {
        properties: {
          layoutProperties: { $ref: "LayoutProperties" },
          masterProperties: { $ref: "MasterProperties" },
          notesProperties: { $ref: "NotesProperties" },
          objectId: { type: "string" },
          pageElements: { items: { $ref: "PageElement" }, type: "array" },
          pageProperties: { $ref: "PageProperties" },
          pageType: {
            enum: ["SLIDE", "MASTER", "LAYOUT", "NOTES", "NOTES_MASTER"],
            type: "string",
          },
          revisionId: { type: "string" },
          slideProperties: { $ref: "SlideProperties" },
        },
        type: "object",
      },
      LayoutProperties: {
        properties: {
          displayName: { type: "string" },
          masterObjectId: { type: "string" },
          name: { type: "string" },
        },
        type: "object",
      },
      MasterProperties: {
        properties: { displayName: { type: "string" } },
        type: "object",
      },
      NotesProperties: {
        properties: { speakerNotesObjectId: { type: "string" } },
        type: "object",
      },
      PageElement: {
        properties: {
          elementGroup: { $ref: "Group" },
          image: { $ref: "Image" },
          line: { $ref: "Line" },
          objectId: { type: "string" },
          shape: { $ref: "Shape" },
          sheetsChart: { $ref: "SheetsChart" },
          size: { $ref: "Size" },
          speakerSpotlight: { $ref: "SpeakerSpotlight" },
          table: { $ref: "Table" },
          title: { type: "string" },
          transform: { $ref: "AffineTransform" },
          video: { $ref: "Video" },
          wordArt: { $ref: "WordArt" },
        },
        type: "object",
      },
      Group: {
        properties: {
          children: { items: { $ref: "PageElement" }, type: "array" },
        },
        type: "object",
      },
      Image: {
        properties: {
          contentUrl: { type: "string" },
          imageProperties: { $ref: "ImageProperties" },
          placeholder: { $ref: "Placeholder" },
          sourceUrl: { type: "string" },
        },
        type: "object",
      },
      Line: {
        properties: {
          lineCategory: {
            enum: ["LINE_CATEGORY_UNSPECIFIED", "STRAIGHT", "BENT", "CURVED"],
            type: "string",
          },
          lineProperties: { $ref: "LineProperties" },
          lineType: {
            enum: [
              "TYPE_UNSPECIFIED",
              "STRAIGHT_CONNECTOR_1",
              "BENT_CONNECTOR_2",
              "BENT_CONNECTOR_3",
              "BENT_CONNECTOR_4",
              "BENT_CONNECTOR_5",
              "CURVED_CONNECTOR_2",
              "CURVED_CONNECTOR_3",
              "CURVED_CONNECTOR_4",
              "CURVED_CONNECTOR_5",
              "STRAIGHT_LINE",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      Shape: {
        properties: {
          placeholder: { $ref: "Placeholder" },
          shapeProperties: { $ref: "ShapeProperties" },
          shapeType: {
            enum: [
              "TYPE_UNSPECIFIED",
              "TEXT_BOX",
              "RECTANGLE",
              "ROUND_RECTANGLE",
              "ELLIPSE",
              "ARC",
              "BENT_ARROW",
              "BENT_UP_ARROW",
              "BEVEL",
              "BLOCK_ARC",
              "BRACE_PAIR",
              "BRACKET_PAIR",
              "CAN",
              "CHEVRON",
              "CHORD",
              "CLOUD",
              "CORNER",
              "CUBE",
              "CURVED_DOWN_ARROW",
              "CURVED_LEFT_ARROW",
              "CURVED_RIGHT_ARROW",
              "CURVED_UP_ARROW",
              "DECAGON",
              "DIAGONAL_STRIPE",
              "DIAMOND",
              "DODECAGON",
              "DONUT",
              "DOUBLE_WAVE",
              "DOWN_ARROW",
              "DOWN_ARROW_CALLOUT",
              "FOLDED_CORNER",
              "FRAME",
              "HALF_FRAME",
              "HEART",
              "HEPTAGON",
              "HEXAGON",
              "HOME_PLATE",
              "HORIZONTAL_SCROLL",
              "IRREGULAR_SEAL_1",
              "IRREGULAR_SEAL_2",
              "LEFT_ARROW",
              "LEFT_ARROW_CALLOUT",
              "LEFT_BRACE",
              "LEFT_BRACKET",
              "LEFT_RIGHT_ARROW",
              "LEFT_RIGHT_ARROW_CALLOUT",
              "LEFT_RIGHT_UP_ARROW",
              "LEFT_UP_ARROW",
              "LIGHTNING_BOLT",
              "MATH_DIVIDE",
              "MATH_EQUAL",
              "MATH_MINUS",
              "MATH_MULTIPLY",
              "MATH_NOT_EQUAL",
              "MATH_PLUS",
              "MOON",
              "NO_SMOKING",
              "NOTCHED_RIGHT_ARROW",
              "OCTAGON",
              "PARALLELOGRAM",
              "PENTAGON",
              "PIE",
              "PLAQUE",
              "PLUS",
              "QUAD_ARROW",
              "QUAD_ARROW_CALLOUT",
              "RIBBON",
              "RIBBON_2",
              "RIGHT_ARROW",
              "RIGHT_ARROW_CALLOUT",
              "RIGHT_BRACE",
              "RIGHT_BRACKET",
              "ROUND_1_RECTANGLE",
              "ROUND_2_DIAGONAL_RECTANGLE",
              "ROUND_2_SAME_RECTANGLE",
              "RIGHT_TRIANGLE",
              "SMILEY_FACE",
              "SNIP_1_RECTANGLE",
              "SNIP_2_DIAGONAL_RECTANGLE",
              "SNIP_2_SAME_RECTANGLE",
              "SNIP_ROUND_RECTANGLE",
              "STAR_10",
              "STAR_12",
              "STAR_16",
              "STAR_24",
              "STAR_32",
              "STAR_4",
              "STAR_5",
              "STAR_6",
              "STAR_7",
              "STAR_8",
              "STRIPED_RIGHT_ARROW",
              "SUN",
              "TRAPEZOID",
              "TRIANGLE",
              "UP_ARROW",
              "UP_ARROW_CALLOUT",
              "UP_DOWN_ARROW",
              "UTURN_ARROW",
              "VERTICAL_SCROLL",
              "WAVE",
              "WEDGE_ELLIPSE_CALLOUT",
              "WEDGE_RECTANGLE_CALLOUT",
              "WEDGE_ROUND_RECTANGLE_CALLOUT",
              "FLOW_CHART_ALTERNATE_PROCESS",
              "FLOW_CHART_COLLATE",
              "FLOW_CHART_CONNECTOR",
              "FLOW_CHART_DECISION",
              "FLOW_CHART_DELAY",
              "FLOW_CHART_DISPLAY",
              "FLOW_CHART_DOCUMENT",
              "FLOW_CHART_EXTRACT",
              "FLOW_CHART_INPUT_OUTPUT",
              "FLOW_CHART_INTERNAL_STORAGE",
              "FLOW_CHART_MAGNETIC_DISK",
              "FLOW_CHART_MAGNETIC_DRUM",
              "FLOW_CHART_MAGNETIC_TAPE",
              "FLOW_CHART_MANUAL_INPUT",
              "FLOW_CHART_MANUAL_OPERATION",
              "FLOW_CHART_MERGE",
              "FLOW_CHART_MULTIDOCUMENT",
              "FLOW_CHART_OFFLINE_STORAGE",
              "FLOW_CHART_OFFPAGE_CONNECTOR",
              "FLOW_CHART_ONLINE_STORAGE",
              "FLOW_CHART_OR",
              "FLOW_CHART_PREDEFINED_PROCESS",
              "FLOW_CHART_PREPARATION",
              "FLOW_CHART_PROCESS",
              "FLOW_CHART_PUNCHED_CARD",
              "FLOW_CHART_PUNCHED_TAPE",
              "FLOW_CHART_SORT",
              "FLOW_CHART_SUMMING_JUNCTION",
              "FLOW_CHART_TERMINATOR",
              "ARROW_EAST",
              "ARROW_NORTH_EAST",
              "ARROW_NORTH",
              "SPEECH",
              "STARBURST",
              "TEARDROP",
              "ELLIPSE_RIBBON",
              "ELLIPSE_RIBBON_2",
              "CLOUD_CALLOUT",
              "CUSTOM",
            ],
            type: "string",
          },
          text: { $ref: "TextContent" },
        },
        type: "object",
      },
      TextContent: {
        properties: {
          lists: { additionalProperties: { $ref: "List" }, type: "object" },
          textElements: { items: { $ref: "TextElement" }, type: "array" },
        },
        type: "object",
      },
      List: {
        properties: {
          listId: { type: "string" },
          nestingLevel: {
            additionalProperties: { $ref: "NestingLevel" },
            type: "object",
          },
        },
        type: "object",
      },
      NestingLevel: {
        properties: { bulletStyle: { $ref: "TextStyle" } },
        type: "object",
      },
      TextStyle: {
        properties: {
          backgroundColor: { $ref: "OptionalColor" },
          baselineOffset: {
            enum: [
              "BASELINE_OFFSET_UNSPECIFIED",
              "NONE",
              "SUPERSCRIPT",
              "SUBSCRIPT",
            ],
            type: "string",
          },
          bold: { type: "boolean" },
          fontFamily: { type: "string" },
          fontSize: { $ref: "Dimension" },
          foregroundColor: { $ref: "OptionalColor" },
          italic: { type: "boolean" },
          link: { $ref: "Link" },
          smallCaps: { type: "boolean" },
          strikethrough: { type: "boolean" },
          underline: { type: "boolean" },
          weightedFontFamily: { $ref: "WeightedFontFamily" },
        },
        type: "object",
      },
      OptionalColor: {
        properties: { opaqueColor: { $ref: "OpaqueColor" } },
        type: "object",
      },
      WeightedFontFamily: {
        properties: {
          fontFamily: { type: "string" },
          weight: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      TextElement: {
        properties: {
          autoText: { $ref: "AutoText" },
          endIndex: { format: "int32", type: "integer" },
          paragraphMarker: { $ref: "ParagraphMarker" },
          startIndex: { format: "int32", type: "integer" },
          textRun: { $ref: "TextRun" },
        },
        type: "object",
      },
      AutoText: {
        properties: {
          content: { type: "string" },
          style: { $ref: "TextStyle" },
          type: { enum: ["TYPE_UNSPECIFIED", "SLIDE_NUMBER"], type: "string" },
        },
        type: "object",
      },
      ParagraphMarker: {
        properties: {
          bullet: { $ref: "Bullet" },
          style: { $ref: "ParagraphStyle" },
        },
        type: "object",
      },
      Bullet: {
        properties: {
          bulletStyle: { $ref: "TextStyle" },
          glyph: { type: "string" },
          listId: { type: "string" },
          nestingLevel: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      TextRun: {
        properties: {
          content: { type: "string" },
          style: { $ref: "TextStyle" },
        },
        type: "object",
      },
      SheetsChart: {
        properties: {
          chartId: { format: "int32", type: "integer" },
          contentUrl: { type: "string" },
          sheetsChartProperties: { $ref: "SheetsChartProperties" },
          spreadsheetId: { type: "string" },
        },
        type: "object",
      },
      SheetsChartProperties: {
        properties: { chartImageProperties: { $ref: "ImageProperties" } },
        type: "object",
      },
      SpeakerSpotlight: {
        properties: {
          speakerSpotlightProperties: { $ref: "SpeakerSpotlightProperties" },
        },
        type: "object",
      },
      SpeakerSpotlightProperties: {
        properties: {
          outline: { $ref: "Outline" },
          shadow: { $ref: "Shadow" },
        },
        type: "object",
      },
      Table: {
        properties: {
          columns: { format: "int32", type: "integer" },
          horizontalBorderRows: {
            items: { $ref: "TableBorderRow" },
            type: "array",
          },
          rows: { format: "int32", type: "integer" },
          tableColumns: {
            items: { $ref: "TableColumnProperties" },
            type: "array",
          },
          tableRows: { items: { $ref: "TableRow" }, type: "array" },
          verticalBorderRows: {
            items: { $ref: "TableBorderRow" },
            type: "array",
          },
        },
        type: "object",
      },
      TableBorderRow: {
        properties: {
          tableBorderCells: {
            items: { $ref: "TableBorderCell" },
            type: "array",
          },
        },
        type: "object",
      },
      TableBorderCell: {
        properties: {
          location: { $ref: "TableCellLocation" },
          tableBorderProperties: { $ref: "TableBorderProperties" },
        },
        type: "object",
      },
      TableBorderProperties: {
        properties: {
          dashStyle: {
            enum: [
              "DASH_STYLE_UNSPECIFIED",
              "SOLID",
              "DOT",
              "DASH",
              "DASH_DOT",
              "LONG_DASH",
              "LONG_DASH_DOT",
            ],
            type: "string",
          },
          tableBorderFill: { $ref: "TableBorderFill" },
          weight: { $ref: "Dimension" },
        },
        type: "object",
      },
      TableBorderFill: {
        properties: { solidFill: { $ref: "SolidFill" } },
        type: "object",
      },
      TableColumnProperties: {
        properties: { columnWidth: { $ref: "Dimension" } },
        type: "object",
      },
      TableRow: {
        properties: {
          rowHeight: { $ref: "Dimension" },
          tableCells: { items: { $ref: "TableCell" }, type: "array" },
          tableRowProperties: { $ref: "TableRowProperties" },
        },
        type: "object",
      },
      TableCell: {
        properties: {
          columnSpan: { format: "int32", type: "integer" },
          location: { $ref: "TableCellLocation" },
          rowSpan: { format: "int32", type: "integer" },
          tableCellProperties: { $ref: "TableCellProperties" },
          text: { $ref: "TextContent" },
        },
        type: "object",
      },
      TableCellProperties: {
        properties: {
          contentAlignment: {
            enum: [
              "CONTENT_ALIGNMENT_UNSPECIFIED",
              "CONTENT_ALIGNMENT_UNSUPPORTED",
              "TOP",
              "MIDDLE",
              "BOTTOM",
            ],
            type: "string",
          },
          tableCellBackgroundFill: { $ref: "TableCellBackgroundFill" },
        },
        type: "object",
      },
      TableCellBackgroundFill: {
        properties: {
          propertyState: {
            enum: ["RENDERED", "NOT_RENDERED", "INHERIT"],
            type: "string",
          },
          solidFill: { $ref: "SolidFill" },
        },
        type: "object",
      },
      TableRowProperties: {
        properties: { minRowHeight: { $ref: "Dimension" } },
        type: "object",
      },
      Video: {
        properties: {
          source: {
            enum: ["SOURCE_UNSPECIFIED", "YOUTUBE", "DRIVE"],
            type: "string",
          },
          url: { type: "string" },
          videoProperties: { $ref: "VideoProperties" },
        },
        type: "object",
      },
      VideoProperties: {
        properties: {
          autoPlay: { type: "boolean" },
          end: { format: "uint32", type: "integer" },
          mute: { type: "boolean" },
          outline: { $ref: "Outline" },
          start: { format: "uint32", type: "integer" },
        },
        type: "object",
      },
      WordArt: {
        properties: { renderedText: { type: "string" } },
        type: "object",
      },
      UpdateSlidesPositionRequest: {
        properties: {
          insertionIndex: { format: "int32", type: "integer" },
          slideObjectIds: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      UpdateTableBorderPropertiesRequest: {
        properties: {
          borderPosition: {
            enum: [
              "ALL",
              "BOTTOM",
              "INNER",
              "INNER_HORIZONTAL",
              "INNER_VERTICAL",
              "LEFT",
              "OUTER",
              "RIGHT",
              "TOP",
            ],
            type: "string",
          },
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          tableBorderProperties: { $ref: "TableBorderProperties" },
          tableRange: { $ref: "TableRange" },
        },
        type: "object",
      },
      UpdateTableCellPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          tableCellProperties: { $ref: "TableCellProperties" },
          tableRange: { $ref: "TableRange" },
        },
        type: "object",
      },
      UpdateTableColumnPropertiesRequest: {
        properties: {
          columnIndices: {
            items: { format: "int32", type: "integer" },
            type: "array",
          },
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          tableColumnProperties: { $ref: "TableColumnProperties" },
        },
        type: "object",
      },
      UpdateTableRowPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          rowIndices: {
            items: { format: "int32", type: "integer" },
            type: "array",
          },
          tableRowProperties: { $ref: "TableRowProperties" },
        },
        type: "object",
      },
      UpdateTextStyleRequest: {
        properties: {
          cellLocation: { $ref: "TableCellLocation" },
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          style: { $ref: "TextStyle" },
          textRange: { $ref: "Range" },
        },
        type: "object",
      },
      UpdateVideoPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { type: "string" },
          videoProperties: { $ref: "VideoProperties" },
        },
        type: "object",
      },
      WriteControl: {
        properties: { requiredRevisionId: { type: "string" } },
        type: "object",
      },
    },
  },
  sheets: {
    root: "BatchUpdateSpreadsheetRequest",
    revision: "20260610",
    schemas: {
      BatchUpdateSpreadsheetRequest: {
        properties: {
          includeSpreadsheetInResponse: { type: "boolean" },
          requests: { items: { $ref: "Request" }, type: "array" },
          responseIncludeGridData: { type: "boolean" },
          responseRanges: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      Request: {
        properties: {
          addBanding: { $ref: "AddBandingRequest" },
          addChart: { $ref: "AddChartRequest" },
          addConditionalFormatRule: { $ref: "AddConditionalFormatRuleRequest" },
          addDataSource: { $ref: "AddDataSourceRequest" },
          addDimensionGroup: { $ref: "AddDimensionGroupRequest" },
          addFilterView: { $ref: "AddFilterViewRequest" },
          addNamedRange: { $ref: "AddNamedRangeRequest" },
          addProtectedRange: { $ref: "AddProtectedRangeRequest" },
          addSheet: { $ref: "AddSheetRequest" },
          addSlicer: { $ref: "AddSlicerRequest" },
          addTable: { $ref: "AddTableRequest" },
          appendCells: { $ref: "AppendCellsRequest" },
          appendDimension: { $ref: "AppendDimensionRequest" },
          autoFill: { $ref: "AutoFillRequest" },
          autoResizeDimensions: { $ref: "AutoResizeDimensionsRequest" },
          cancelDataSourceRefresh: { $ref: "CancelDataSourceRefreshRequest" },
          clearBasicFilter: { $ref: "ClearBasicFilterRequest" },
          copyPaste: { $ref: "CopyPasteRequest" },
          createDeveloperMetadata: { $ref: "CreateDeveloperMetadataRequest" },
          cutPaste: { $ref: "CutPasteRequest" },
          deleteBanding: { $ref: "DeleteBandingRequest" },
          deleteConditionalFormatRule: {
            $ref: "DeleteConditionalFormatRuleRequest",
          },
          deleteDataSource: { $ref: "DeleteDataSourceRequest" },
          deleteDeveloperMetadata: { $ref: "DeleteDeveloperMetadataRequest" },
          deleteDimension: { $ref: "DeleteDimensionRequest" },
          deleteDimensionGroup: { $ref: "DeleteDimensionGroupRequest" },
          deleteDuplicates: { $ref: "DeleteDuplicatesRequest" },
          deleteEmbeddedObject: { $ref: "DeleteEmbeddedObjectRequest" },
          deleteFilterView: { $ref: "DeleteFilterViewRequest" },
          deleteNamedRange: { $ref: "DeleteNamedRangeRequest" },
          deleteProtectedRange: { $ref: "DeleteProtectedRangeRequest" },
          deleteRange: { $ref: "DeleteRangeRequest" },
          deleteSheet: { $ref: "DeleteSheetRequest" },
          deleteTable: { $ref: "DeleteTableRequest" },
          duplicateFilterView: { $ref: "DuplicateFilterViewRequest" },
          duplicateSheet: { $ref: "DuplicateSheetRequest" },
          findReplace: { $ref: "FindReplaceRequest" },
          insertDimension: { $ref: "InsertDimensionRequest" },
          insertRange: { $ref: "InsertRangeRequest" },
          mergeCells: { $ref: "MergeCellsRequest" },
          moveDimension: { $ref: "MoveDimensionRequest" },
          pasteData: { $ref: "PasteDataRequest" },
          randomizeRange: { $ref: "RandomizeRangeRequest" },
          refreshDataSource: { $ref: "RefreshDataSourceRequest" },
          repeatCell: { $ref: "RepeatCellRequest" },
          setBasicFilter: { $ref: "SetBasicFilterRequest" },
          setDataValidation: { $ref: "SetDataValidationRequest" },
          sortRange: { $ref: "SortRangeRequest" },
          textToColumns: { $ref: "TextToColumnsRequest" },
          trimWhitespace: { $ref: "TrimWhitespaceRequest" },
          unmergeCells: { $ref: "UnmergeCellsRequest" },
          updateBanding: { $ref: "UpdateBandingRequest" },
          updateBorders: { $ref: "UpdateBordersRequest" },
          updateCells: { $ref: "UpdateCellsRequest" },
          updateChartSpec: { $ref: "UpdateChartSpecRequest" },
          updateConditionalFormatRule: {
            $ref: "UpdateConditionalFormatRuleRequest",
          },
          updateDataSource: { $ref: "UpdateDataSourceRequest" },
          updateDeveloperMetadata: { $ref: "UpdateDeveloperMetadataRequest" },
          updateDimensionGroup: { $ref: "UpdateDimensionGroupRequest" },
          updateDimensionProperties: {
            $ref: "UpdateDimensionPropertiesRequest",
          },
          updateEmbeddedObjectBorder: {
            $ref: "UpdateEmbeddedObjectBorderRequest",
          },
          updateEmbeddedObjectPosition: {
            $ref: "UpdateEmbeddedObjectPositionRequest",
          },
          updateFilterView: { $ref: "UpdateFilterViewRequest" },
          updateNamedRange: { $ref: "UpdateNamedRangeRequest" },
          updateProtectedRange: { $ref: "UpdateProtectedRangeRequest" },
          updateSheetProperties: { $ref: "UpdateSheetPropertiesRequest" },
          updateSlicerSpec: { $ref: "UpdateSlicerSpecRequest" },
          updateSpreadsheetProperties: {
            $ref: "UpdateSpreadsheetPropertiesRequest",
          },
          updateTable: { $ref: "UpdateTableRequest" },
        },
        type: "object",
      },
      AddBandingRequest: {
        properties: { bandedRange: { $ref: "BandedRange" } },
        type: "object",
      },
      BandedRange: {
        properties: {
          bandedRangeId: { format: "int32", type: "integer" },
          bandedRangeReference: { readOnly: true, type: "string" },
          columnProperties: { $ref: "BandingProperties" },
          range: { $ref: "GridRange" },
          rowProperties: { $ref: "BandingProperties" },
        },
        type: "object",
      },
      BandingProperties: {
        properties: {
          firstBandColor: { $ref: "Color", deprecated: true },
          firstBandColorStyle: { $ref: "ColorStyle" },
          footerColor: { $ref: "Color", deprecated: true },
          footerColorStyle: { $ref: "ColorStyle" },
          headerColor: { $ref: "Color", deprecated: true },
          headerColorStyle: { $ref: "ColorStyle" },
          secondBandColor: { $ref: "Color", deprecated: true },
          secondBandColorStyle: { $ref: "ColorStyle" },
        },
        type: "object",
      },
      Color: {
        properties: {
          alpha: { format: "float", type: "number" },
          blue: { format: "float", type: "number" },
          green: { format: "float", type: "number" },
          red: { format: "float", type: "number" },
        },
        type: "object",
      },
      ColorStyle: {
        properties: {
          rgbColor: { $ref: "Color" },
          themeColor: {
            enum: [
              "THEME_COLOR_TYPE_UNSPECIFIED",
              "TEXT",
              "BACKGROUND",
              "ACCENT1",
              "ACCENT2",
              "ACCENT3",
              "ACCENT4",
              "ACCENT5",
              "ACCENT6",
              "LINK",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      GridRange: {
        properties: {
          endColumnIndex: { format: "int32", type: "integer" },
          endRowIndex: { format: "int32", type: "integer" },
          sheetId: { format: "int32", type: "integer" },
          startColumnIndex: { format: "int32", type: "integer" },
          startRowIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      AddChartRequest: {
        properties: { chart: { $ref: "EmbeddedChart" } },
        type: "object",
      },
      EmbeddedChart: {
        properties: {
          border: { $ref: "EmbeddedObjectBorder" },
          chartId: { format: "int32", type: "integer" },
          position: { $ref: "EmbeddedObjectPosition" },
          spec: { $ref: "ChartSpec" },
        },
        type: "object",
      },
      EmbeddedObjectBorder: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
        },
        type: "object",
      },
      EmbeddedObjectPosition: {
        properties: {
          newSheet: { type: "boolean" },
          overlayPosition: { $ref: "OverlayPosition" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      OverlayPosition: {
        properties: {
          anchorCell: { $ref: "GridCoordinate" },
          heightPixels: { format: "int32", type: "integer" },
          offsetXPixels: { format: "int32", type: "integer" },
          offsetYPixels: { format: "int32", type: "integer" },
          widthPixels: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      GridCoordinate: {
        properties: {
          columnIndex: { format: "int32", type: "integer" },
          rowIndex: { format: "int32", type: "integer" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      ChartSpec: {
        properties: {
          altText: { type: "string" },
          backgroundColor: { $ref: "Color", deprecated: true },
          backgroundColorStyle: { $ref: "ColorStyle" },
          basicChart: { $ref: "BasicChartSpec" },
          bubbleChart: { $ref: "BubbleChartSpec" },
          candlestickChart: { $ref: "CandlestickChartSpec" },
          dataSourceChartProperties: { $ref: "DataSourceChartProperties" },
          filterSpecs: { items: { $ref: "FilterSpec" }, type: "array" },
          fontName: { type: "string" },
          hiddenDimensionStrategy: {
            enum: [
              "CHART_HIDDEN_DIMENSION_STRATEGY_UNSPECIFIED",
              "SKIP_HIDDEN_ROWS_AND_COLUMNS",
              "SKIP_HIDDEN_ROWS",
              "SKIP_HIDDEN_COLUMNS",
              "SHOW_ALL",
            ],
            type: "string",
          },
          histogramChart: { $ref: "HistogramChartSpec" },
          maximized: { type: "boolean" },
          orgChart: { $ref: "OrgChartSpec" },
          pieChart: { $ref: "PieChartSpec" },
          scorecardChart: { $ref: "ScorecardChartSpec" },
          sortSpecs: { items: { $ref: "SortSpec" }, type: "array" },
          subtitle: { type: "string" },
          subtitleTextFormat: { $ref: "TextFormat" },
          subtitleTextPosition: { $ref: "TextPosition" },
          title: { type: "string" },
          titleTextFormat: { $ref: "TextFormat" },
          titleTextPosition: { $ref: "TextPosition" },
          treemapChart: { $ref: "TreemapChartSpec" },
          waterfallChart: { $ref: "WaterfallChartSpec" },
        },
        type: "object",
      },
      BasicChartSpec: {
        properties: {
          axis: { items: { $ref: "BasicChartAxis" }, type: "array" },
          chartType: {
            enum: [
              "BASIC_CHART_TYPE_UNSPECIFIED",
              "BAR",
              "LINE",
              "AREA",
              "COLUMN",
              "SCATTER",
              "COMBO",
              "STEPPED_AREA",
            ],
            type: "string",
          },
          compareMode: {
            enum: ["BASIC_CHART_COMPARE_MODE_UNSPECIFIED", "DATUM", "CATEGORY"],
            type: "string",
          },
          domains: { items: { $ref: "BasicChartDomain" }, type: "array" },
          headerCount: { format: "int32", type: "integer" },
          interpolateNulls: { type: "boolean" },
          legendPosition: {
            enum: [
              "BASIC_CHART_LEGEND_POSITION_UNSPECIFIED",
              "BOTTOM_LEGEND",
              "LEFT_LEGEND",
              "RIGHT_LEGEND",
              "TOP_LEGEND",
              "NO_LEGEND",
            ],
            type: "string",
          },
          lineSmoothing: { type: "boolean" },
          series: { items: { $ref: "BasicChartSeries" }, type: "array" },
          stackedType: {
            enum: [
              "BASIC_CHART_STACKED_TYPE_UNSPECIFIED",
              "NOT_STACKED",
              "STACKED",
              "PERCENT_STACKED",
            ],
            type: "string",
          },
          threeDimensional: { type: "boolean" },
          totalDataLabel: { $ref: "DataLabel" },
        },
        type: "object",
      },
      BasicChartAxis: {
        properties: {
          format: { $ref: "TextFormat" },
          position: {
            enum: [
              "BASIC_CHART_AXIS_POSITION_UNSPECIFIED",
              "BOTTOM_AXIS",
              "LEFT_AXIS",
              "RIGHT_AXIS",
            ],
            type: "string",
          },
          title: { type: "string" },
          titleTextPosition: { $ref: "TextPosition" },
          viewWindowOptions: { $ref: "ChartAxisViewWindowOptions" },
        },
        type: "object",
      },
      TextFormat: {
        properties: {
          bold: { type: "boolean" },
          fontFamily: { type: "string" },
          fontSize: { format: "int32", type: "integer" },
          foregroundColor: { $ref: "Color", deprecated: true },
          foregroundColorStyle: { $ref: "ColorStyle" },
          italic: { type: "boolean" },
          link: { $ref: "Link" },
          strikethrough: { type: "boolean" },
          underline: { type: "boolean" },
        },
        type: "object",
      },
      Link: { properties: { uri: { type: "string" } }, type: "object" },
      TextPosition: {
        properties: {
          horizontalAlignment: {
            enum: ["HORIZONTAL_ALIGN_UNSPECIFIED", "LEFT", "CENTER", "RIGHT"],
            type: "string",
          },
        },
        type: "object",
      },
      ChartAxisViewWindowOptions: {
        properties: {
          viewWindowMax: { format: "double", type: "number" },
          viewWindowMin: { format: "double", type: "number" },
          viewWindowMode: {
            enum: [
              "DEFAULT_VIEW_WINDOW_MODE",
              "VIEW_WINDOW_MODE_UNSUPPORTED",
              "EXPLICIT",
              "PRETTY",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      BasicChartDomain: {
        properties: {
          domain: { $ref: "ChartData" },
          reversed: { type: "boolean" },
        },
        type: "object",
      },
      ChartData: {
        properties: {
          aggregateType: {
            enum: [
              "CHART_AGGREGATE_TYPE_UNSPECIFIED",
              "AVERAGE",
              "COUNT",
              "MAX",
              "MEDIAN",
              "MIN",
              "SUM",
            ],
            type: "string",
          },
          columnReference: { $ref: "DataSourceColumnReference" },
          groupRule: { $ref: "ChartGroupRule" },
          sourceRange: { $ref: "ChartSourceRange" },
        },
        type: "object",
      },
      DataSourceColumnReference: {
        properties: { name: { type: "string" } },
        type: "object",
      },
      ChartGroupRule: {
        properties: {
          dateTimeRule: { $ref: "ChartDateTimeRule" },
          histogramRule: { $ref: "ChartHistogramRule" },
        },
        type: "object",
      },
      ChartDateTimeRule: {
        properties: {
          type: {
            enum: [
              "CHART_DATE_TIME_RULE_TYPE_UNSPECIFIED",
              "SECOND",
              "MINUTE",
              "HOUR",
              "HOUR_MINUTE",
              "HOUR_MINUTE_AMPM",
              "DAY_OF_WEEK",
              "DAY_OF_YEAR",
              "DAY_OF_MONTH",
              "DAY_MONTH",
              "MONTH",
              "QUARTER",
              "YEAR",
              "YEAR_MONTH",
              "YEAR_QUARTER",
              "YEAR_MONTH_DAY",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      ChartHistogramRule: {
        properties: {
          intervalSize: { format: "double", type: "number" },
          maxValue: { format: "double", type: "number" },
          minValue: { format: "double", type: "number" },
        },
        type: "object",
      },
      ChartSourceRange: {
        properties: {
          sources: { items: { $ref: "GridRange" }, type: "array" },
        },
        type: "object",
      },
      BasicChartSeries: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
          dataLabel: { $ref: "DataLabel" },
          lineStyle: { $ref: "LineStyle" },
          pointStyle: { $ref: "PointStyle" },
          series: { $ref: "ChartData" },
          styleOverrides: {
            items: { $ref: "BasicSeriesDataPointStyleOverride" },
            type: "array",
          },
          targetAxis: {
            enum: [
              "BASIC_CHART_AXIS_POSITION_UNSPECIFIED",
              "BOTTOM_AXIS",
              "LEFT_AXIS",
              "RIGHT_AXIS",
            ],
            type: "string",
          },
          type: {
            enum: [
              "BASIC_CHART_TYPE_UNSPECIFIED",
              "BAR",
              "LINE",
              "AREA",
              "COLUMN",
              "SCATTER",
              "COMBO",
              "STEPPED_AREA",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      DataLabel: {
        properties: {
          customLabelData: { $ref: "ChartData" },
          placement: {
            enum: [
              "DATA_LABEL_PLACEMENT_UNSPECIFIED",
              "CENTER",
              "LEFT",
              "RIGHT",
              "ABOVE",
              "BELOW",
              "INSIDE_END",
              "INSIDE_BASE",
              "OUTSIDE_END",
            ],
            type: "string",
          },
          textFormat: { $ref: "TextFormat" },
          type: {
            enum: ["DATA_LABEL_TYPE_UNSPECIFIED", "NONE", "DATA", "CUSTOM"],
            type: "string",
          },
        },
        type: "object",
      },
      LineStyle: {
        properties: {
          type: {
            enum: [
              "LINE_DASH_TYPE_UNSPECIFIED",
              "INVISIBLE",
              "CUSTOM",
              "SOLID",
              "DOTTED",
              "MEDIUM_DASHED",
              "MEDIUM_DASHED_DOTTED",
              "LONG_DASHED",
              "LONG_DASHED_DOTTED",
            ],
            type: "string",
          },
          width: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      PointStyle: {
        properties: {
          shape: {
            enum: [
              "POINT_SHAPE_UNSPECIFIED",
              "CIRCLE",
              "DIAMOND",
              "HEXAGON",
              "PENTAGON",
              "SQUARE",
              "STAR",
              "TRIANGLE",
              "X_MARK",
            ],
            type: "string",
          },
          size: { format: "double", type: "number" },
        },
        type: "object",
      },
      BasicSeriesDataPointStyleOverride: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
          index: { format: "int32", type: "integer" },
          pointStyle: { $ref: "PointStyle" },
        },
        type: "object",
      },
      BubbleChartSpec: {
        properties: {
          bubbleBorderColor: { $ref: "Color", deprecated: true },
          bubbleBorderColorStyle: { $ref: "ColorStyle" },
          bubbleLabels: { $ref: "ChartData" },
          bubbleMaxRadiusSize: { format: "int32", type: "integer" },
          bubbleMinRadiusSize: { format: "int32", type: "integer" },
          bubbleOpacity: { format: "float", type: "number" },
          bubbleSizes: { $ref: "ChartData" },
          bubbleTextStyle: { $ref: "TextFormat" },
          domain: { $ref: "ChartData" },
          groupIds: { $ref: "ChartData" },
          legendPosition: {
            enum: [
              "BUBBLE_CHART_LEGEND_POSITION_UNSPECIFIED",
              "BOTTOM_LEGEND",
              "LEFT_LEGEND",
              "RIGHT_LEGEND",
              "TOP_LEGEND",
              "NO_LEGEND",
              "INSIDE_LEGEND",
            ],
            type: "string",
          },
          series: { $ref: "ChartData" },
        },
        type: "object",
      },
      CandlestickChartSpec: {
        properties: {
          data: { items: { $ref: "CandlestickData" }, type: "array" },
          domain: { $ref: "CandlestickDomain" },
        },
        type: "object",
      },
      CandlestickData: {
        properties: {
          closeSeries: { $ref: "CandlestickSeries" },
          highSeries: { $ref: "CandlestickSeries" },
          lowSeries: { $ref: "CandlestickSeries" },
          openSeries: { $ref: "CandlestickSeries" },
        },
        type: "object",
      },
      CandlestickSeries: {
        properties: { data: { $ref: "ChartData" } },
        type: "object",
      },
      CandlestickDomain: {
        properties: {
          data: { $ref: "ChartData" },
          reversed: { type: "boolean" },
        },
        type: "object",
      },
      DataSourceChartProperties: {
        properties: {
          dataExecutionStatus: { $ref: "DataExecutionStatus", readOnly: true },
          dataSourceId: { type: "string" },
        },
        type: "object",
      },
      DataExecutionStatus: {
        properties: {
          errorCode: {
            enum: [
              "DATA_EXECUTION_ERROR_CODE_UNSPECIFIED",
              "TIMED_OUT",
              "TOO_MANY_ROWS",
              "TOO_MANY_COLUMNS",
              "TOO_MANY_CELLS",
              "ENGINE",
              "PARAMETER_INVALID",
              "UNSUPPORTED_DATA_TYPE",
              "DUPLICATE_COLUMN_NAMES",
              "INTERRUPTED",
              "CONCURRENT_QUERY",
              "OTHER",
              "TOO_MANY_CHARS_PER_CELL",
              "DATA_NOT_FOUND",
              "PERMISSION_DENIED",
              "MISSING_COLUMN_ALIAS",
              "OBJECT_NOT_FOUND",
              "OBJECT_IN_ERROR_STATE",
              "OBJECT_SPEC_INVALID",
              "DATA_EXECUTION_CANCELLED",
            ],
            type: "string",
          },
          errorMessage: { type: "string" },
          lastRefreshTime: { format: "google-datetime", type: "string" },
          state: {
            enum: [
              "DATA_EXECUTION_STATE_UNSPECIFIED",
              "NOT_STARTED",
              "RUNNING",
              "CANCELLING",
              "SUCCEEDED",
              "FAILED",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      FilterSpec: {
        properties: {
          columnIndex: { format: "int32", type: "integer" },
          dataSourceColumnReference: { $ref: "DataSourceColumnReference" },
          filterCriteria: { $ref: "FilterCriteria" },
        },
        type: "object",
      },
      FilterCriteria: {
        properties: {
          condition: { $ref: "BooleanCondition" },
          hiddenValues: { items: { type: "string" }, type: "array" },
          visibleBackgroundColor: { $ref: "Color", deprecated: true },
          visibleBackgroundColorStyle: { $ref: "ColorStyle" },
          visibleForegroundColor: { $ref: "Color", deprecated: true },
          visibleForegroundColorStyle: { $ref: "ColorStyle" },
        },
        type: "object",
      },
      BooleanCondition: {
        properties: {
          type: {
            enum: [
              "CONDITION_TYPE_UNSPECIFIED",
              "NUMBER_GREATER",
              "NUMBER_GREATER_THAN_EQ",
              "NUMBER_LESS",
              "NUMBER_LESS_THAN_EQ",
              "NUMBER_EQ",
              "NUMBER_NOT_EQ",
              "NUMBER_BETWEEN",
              "NUMBER_NOT_BETWEEN",
              "TEXT_CONTAINS",
              "TEXT_NOT_CONTAINS",
              "TEXT_STARTS_WITH",
              "TEXT_ENDS_WITH",
              "TEXT_EQ",
              "TEXT_IS_EMAIL",
              "TEXT_IS_URL",
              "DATE_EQ",
              "DATE_BEFORE",
              "DATE_AFTER",
              "DATE_ON_OR_BEFORE",
              "DATE_ON_OR_AFTER",
              "DATE_BETWEEN",
              "DATE_NOT_BETWEEN",
              "DATE_IS_VALID",
              "ONE_OF_RANGE",
              "ONE_OF_LIST",
              "BLANK",
              "NOT_BLANK",
              "CUSTOM_FORMULA",
              "BOOLEAN",
              "TEXT_NOT_EQ",
              "DATE_NOT_EQ",
              "FILTER_EXPRESSION",
            ],
            type: "string",
          },
          values: { items: { $ref: "ConditionValue" }, type: "array" },
        },
        type: "object",
      },
      ConditionValue: {
        properties: {
          relativeDate: {
            enum: [
              "RELATIVE_DATE_UNSPECIFIED",
              "PAST_YEAR",
              "PAST_MONTH",
              "PAST_WEEK",
              "YESTERDAY",
              "TODAY",
              "TOMORROW",
            ],
            type: "string",
          },
          userEnteredValue: { type: "string" },
        },
        type: "object",
      },
      HistogramChartSpec: {
        properties: {
          bucketSize: { format: "double", type: "number" },
          legendPosition: {
            enum: [
              "HISTOGRAM_CHART_LEGEND_POSITION_UNSPECIFIED",
              "BOTTOM_LEGEND",
              "LEFT_LEGEND",
              "RIGHT_LEGEND",
              "TOP_LEGEND",
              "NO_LEGEND",
              "INSIDE_LEGEND",
            ],
            type: "string",
          },
          outlierPercentile: { format: "double", type: "number" },
          series: { items: { $ref: "HistogramSeries" }, type: "array" },
          showItemDividers: { type: "boolean" },
        },
        type: "object",
      },
      HistogramSeries: {
        properties: {
          barColor: { $ref: "Color", deprecated: true },
          barColorStyle: { $ref: "ColorStyle" },
          data: { $ref: "ChartData" },
        },
        type: "object",
      },
      OrgChartSpec: {
        properties: {
          labels: { $ref: "ChartData" },
          nodeColor: { $ref: "Color", deprecated: true },
          nodeColorStyle: { $ref: "ColorStyle" },
          nodeSize: {
            enum: [
              "ORG_CHART_LABEL_SIZE_UNSPECIFIED",
              "SMALL",
              "MEDIUM",
              "LARGE",
            ],
            type: "string",
          },
          parentLabels: { $ref: "ChartData" },
          selectedNodeColor: { $ref: "Color", deprecated: true },
          selectedNodeColorStyle: { $ref: "ColorStyle" },
          tooltips: { $ref: "ChartData" },
        },
        type: "object",
      },
      PieChartSpec: {
        properties: {
          domain: { $ref: "ChartData" },
          legendPosition: {
            enum: [
              "PIE_CHART_LEGEND_POSITION_UNSPECIFIED",
              "BOTTOM_LEGEND",
              "LEFT_LEGEND",
              "RIGHT_LEGEND",
              "TOP_LEGEND",
              "NO_LEGEND",
              "LABELED_LEGEND",
            ],
            type: "string",
          },
          pieHole: { format: "double", type: "number" },
          series: { $ref: "ChartData" },
          threeDimensional: { type: "boolean" },
        },
        type: "object",
      },
      ScorecardChartSpec: {
        properties: {
          aggregateType: {
            enum: [
              "CHART_AGGREGATE_TYPE_UNSPECIFIED",
              "AVERAGE",
              "COUNT",
              "MAX",
              "MEDIAN",
              "MIN",
              "SUM",
            ],
            type: "string",
          },
          baselineValueData: { $ref: "ChartData" },
          baselineValueFormat: { $ref: "BaselineValueFormat" },
          customFormatOptions: { $ref: "ChartCustomNumberFormatOptions" },
          keyValueData: { $ref: "ChartData" },
          keyValueFormat: { $ref: "KeyValueFormat" },
          numberFormatSource: {
            enum: [
              "CHART_NUMBER_FORMAT_SOURCE_UNDEFINED",
              "FROM_DATA",
              "CUSTOM",
            ],
            type: "string",
          },
          scaleFactor: { format: "double", type: "number" },
        },
        type: "object",
      },
      BaselineValueFormat: {
        properties: {
          comparisonType: {
            enum: [
              "COMPARISON_TYPE_UNDEFINED",
              "ABSOLUTE_DIFFERENCE",
              "PERCENTAGE_DIFFERENCE",
            ],
            type: "string",
          },
          negativeColor: { $ref: "Color", deprecated: true },
          negativeColorStyle: { $ref: "ColorStyle" },
          position: { $ref: "TextPosition" },
          positiveColor: { $ref: "Color", deprecated: true },
          positiveColorStyle: { $ref: "ColorStyle" },
          textFormat: { $ref: "TextFormat" },
        },
        type: "object",
      },
      ChartCustomNumberFormatOptions: {
        properties: { prefix: { type: "string" }, suffix: { type: "string" } },
        type: "object",
      },
      KeyValueFormat: {
        properties: {
          position: { $ref: "TextPosition" },
          textFormat: { $ref: "TextFormat" },
        },
        type: "object",
      },
      SortSpec: {
        properties: {
          backgroundColor: { $ref: "Color", deprecated: true },
          backgroundColorStyle: { $ref: "ColorStyle" },
          dataSourceColumnReference: { $ref: "DataSourceColumnReference" },
          dimensionIndex: { format: "int32", type: "integer" },
          foregroundColor: { $ref: "Color", deprecated: true },
          foregroundColorStyle: { $ref: "ColorStyle" },
          sortOrder: {
            enum: ["SORT_ORDER_UNSPECIFIED", "ASCENDING", "DESCENDING"],
            type: "string",
          },
        },
        type: "object",
      },
      TreemapChartSpec: {
        properties: {
          colorData: { $ref: "ChartData" },
          colorScale: { $ref: "TreemapChartColorScale" },
          headerColor: { $ref: "Color", deprecated: true },
          headerColorStyle: { $ref: "ColorStyle" },
          hideTooltips: { type: "boolean" },
          hintedLevels: { format: "int32", type: "integer" },
          labels: { $ref: "ChartData" },
          levels: { format: "int32", type: "integer" },
          maxValue: { format: "double", type: "number" },
          minValue: { format: "double", type: "number" },
          parentLabels: { $ref: "ChartData" },
          sizeData: { $ref: "ChartData" },
          textFormat: { $ref: "TextFormat" },
        },
        type: "object",
      },
      TreemapChartColorScale: {
        properties: {
          maxValueColor: { $ref: "Color", deprecated: true },
          maxValueColorStyle: { $ref: "ColorStyle" },
          midValueColor: { $ref: "Color", deprecated: true },
          midValueColorStyle: { $ref: "ColorStyle" },
          minValueColor: { $ref: "Color", deprecated: true },
          minValueColorStyle: { $ref: "ColorStyle" },
          noDataColor: { $ref: "Color", deprecated: true },
          noDataColorStyle: { $ref: "ColorStyle" },
        },
        type: "object",
      },
      WaterfallChartSpec: {
        properties: {
          connectorLineStyle: { $ref: "LineStyle" },
          domain: { $ref: "WaterfallChartDomain" },
          firstValueIsTotal: { type: "boolean" },
          hideConnectorLines: { type: "boolean" },
          series: { items: { $ref: "WaterfallChartSeries" }, type: "array" },
          stackedType: {
            enum: [
              "WATERFALL_STACKED_TYPE_UNSPECIFIED",
              "STACKED",
              "SEQUENTIAL",
            ],
            type: "string",
          },
          totalDataLabel: { $ref: "DataLabel" },
        },
        type: "object",
      },
      WaterfallChartDomain: {
        properties: {
          data: { $ref: "ChartData" },
          reversed: { type: "boolean" },
        },
        type: "object",
      },
      WaterfallChartSeries: {
        properties: {
          customSubtotals: {
            items: { $ref: "WaterfallChartCustomSubtotal" },
            type: "array",
          },
          data: { $ref: "ChartData" },
          dataLabel: { $ref: "DataLabel" },
          hideTrailingSubtotal: { type: "boolean" },
          negativeColumnsStyle: { $ref: "WaterfallChartColumnStyle" },
          positiveColumnsStyle: { $ref: "WaterfallChartColumnStyle" },
          subtotalColumnsStyle: { $ref: "WaterfallChartColumnStyle" },
        },
        type: "object",
      },
      WaterfallChartCustomSubtotal: {
        properties: {
          dataIsSubtotal: { type: "boolean" },
          label: { type: "string" },
          subtotalIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      WaterfallChartColumnStyle: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
          label: { type: "string" },
        },
        type: "object",
      },
      AddConditionalFormatRuleRequest: {
        properties: {
          index: { format: "int32", type: "integer" },
          rule: { $ref: "ConditionalFormatRule" },
        },
        type: "object",
      },
      ConditionalFormatRule: {
        properties: {
          booleanRule: { $ref: "BooleanRule" },
          gradientRule: { $ref: "GradientRule" },
          ranges: { items: { $ref: "GridRange" }, type: "array" },
        },
        type: "object",
      },
      BooleanRule: {
        properties: {
          condition: { $ref: "BooleanCondition" },
          format: { $ref: "CellFormat" },
        },
        type: "object",
      },
      CellFormat: {
        properties: {
          backgroundColor: { $ref: "Color", deprecated: true },
          backgroundColorStyle: { $ref: "ColorStyle" },
          borders: { $ref: "Borders" },
          horizontalAlignment: {
            enum: ["HORIZONTAL_ALIGN_UNSPECIFIED", "LEFT", "CENTER", "RIGHT"],
            type: "string",
          },
          hyperlinkDisplayType: {
            enum: [
              "HYPERLINK_DISPLAY_TYPE_UNSPECIFIED",
              "LINKED",
              "PLAIN_TEXT",
            ],
            type: "string",
          },
          numberFormat: { $ref: "NumberFormat" },
          padding: { $ref: "Padding" },
          textDirection: {
            enum: [
              "TEXT_DIRECTION_UNSPECIFIED",
              "LEFT_TO_RIGHT",
              "RIGHT_TO_LEFT",
            ],
            type: "string",
          },
          textFormat: { $ref: "TextFormat" },
          textRotation: { $ref: "TextRotation" },
          verticalAlignment: {
            enum: ["VERTICAL_ALIGN_UNSPECIFIED", "TOP", "MIDDLE", "BOTTOM"],
            type: "string",
          },
          wrapStrategy: {
            enum: [
              "WRAP_STRATEGY_UNSPECIFIED",
              "OVERFLOW_CELL",
              "LEGACY_WRAP",
              "CLIP",
              "WRAP",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      Borders: {
        properties: {
          bottom: { $ref: "Border" },
          left: { $ref: "Border" },
          right: { $ref: "Border" },
          top: { $ref: "Border" },
        },
        type: "object",
      },
      Border: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
          style: {
            enum: [
              "STYLE_UNSPECIFIED",
              "DOTTED",
              "DASHED",
              "SOLID",
              "SOLID_MEDIUM",
              "SOLID_THICK",
              "NONE",
              "DOUBLE",
            ],
            type: "string",
          },
          width: { deprecated: true, format: "int32", type: "integer" },
        },
        type: "object",
      },
      NumberFormat: {
        properties: {
          pattern: { type: "string" },
          type: {
            enum: [
              "NUMBER_FORMAT_TYPE_UNSPECIFIED",
              "TEXT",
              "NUMBER",
              "PERCENT",
              "CURRENCY",
              "DATE",
              "TIME",
              "DATE_TIME",
              "SCIENTIFIC",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      Padding: {
        properties: {
          bottom: { format: "int32", type: "integer" },
          left: { format: "int32", type: "integer" },
          right: { format: "int32", type: "integer" },
          top: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      TextRotation: {
        properties: {
          angle: { format: "int32", type: "integer" },
          vertical: { type: "boolean" },
        },
        type: "object",
      },
      GradientRule: {
        properties: {
          maxpoint: { $ref: "InterpolationPoint" },
          midpoint: { $ref: "InterpolationPoint" },
          minpoint: { $ref: "InterpolationPoint" },
        },
        type: "object",
      },
      InterpolationPoint: {
        properties: {
          color: { $ref: "Color", deprecated: true },
          colorStyle: { $ref: "ColorStyle" },
          type: {
            enum: [
              "INTERPOLATION_POINT_TYPE_UNSPECIFIED",
              "MIN",
              "MAX",
              "NUMBER",
              "PERCENT",
              "PERCENTILE",
            ],
            type: "string",
          },
          value: { type: "string" },
        },
        type: "object",
      },
      AddDataSourceRequest: {
        properties: { dataSource: { $ref: "DataSource" } },
        type: "object",
      },
      DataSource: {
        properties: {
          calculatedColumns: {
            items: { $ref: "DataSourceColumn" },
            type: "array",
          },
          dataSourceId: { type: "string" },
          sheetId: { format: "int32", type: "integer" },
          spec: { $ref: "DataSourceSpec" },
        },
        type: "object",
      },
      DataSourceColumn: {
        properties: {
          formula: { type: "string" },
          reference: { $ref: "DataSourceColumnReference" },
        },
        type: "object",
      },
      DataSourceSpec: {
        properties: {
          bigQuery: { $ref: "BigQueryDataSourceSpec" },
          looker: { $ref: "LookerDataSourceSpec" },
          parameters: { items: { $ref: "DataSourceParameter" }, type: "array" },
        },
        type: "object",
      },
      BigQueryDataSourceSpec: {
        properties: {
          projectId: { type: "string" },
          querySpec: { $ref: "BigQueryQuerySpec" },
          tableSpec: { $ref: "BigQueryTableSpec" },
        },
        type: "object",
      },
      BigQueryQuerySpec: {
        properties: { rawQuery: { type: "string" } },
        type: "object",
      },
      BigQueryTableSpec: {
        properties: {
          datasetId: { type: "string" },
          tableId: { type: "string" },
          tableProjectId: { type: "string" },
        },
        type: "object",
      },
      LookerDataSourceSpec: {
        properties: {
          explore: { type: "string" },
          instanceUri: { type: "string" },
          model: { type: "string" },
        },
        type: "object",
      },
      DataSourceParameter: {
        properties: {
          name: { type: "string" },
          namedRangeId: { type: "string" },
          range: { $ref: "GridRange" },
        },
        type: "object",
      },
      AddDimensionGroupRequest: {
        properties: { range: { $ref: "DimensionRange" } },
        type: "object",
      },
      DimensionRange: {
        properties: {
          dimension: {
            enum: ["DIMENSION_UNSPECIFIED", "ROWS", "COLUMNS"],
            type: "string",
          },
          endIndex: { format: "int32", type: "integer" },
          sheetId: { format: "int32", type: "integer" },
          startIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      AddFilterViewRequest: {
        properties: { filter: { $ref: "FilterView" } },
        type: "object",
      },
      FilterView: {
        properties: {
          criteria: {
            additionalProperties: { $ref: "FilterCriteria" },
            deprecated: true,
            type: "object",
          },
          filterSpecs: { items: { $ref: "FilterSpec" }, type: "array" },
          filterViewId: { format: "int32", type: "integer" },
          namedRangeId: { type: "string" },
          range: { $ref: "GridRange" },
          sortSpecs: { items: { $ref: "SortSpec" }, type: "array" },
          tableId: { type: "string" },
          title: { type: "string" },
        },
        type: "object",
      },
      AddNamedRangeRequest: {
        properties: { namedRange: { $ref: "NamedRange" } },
        type: "object",
      },
      NamedRange: {
        properties: {
          name: { type: "string" },
          namedRangeId: { type: "string" },
          range: { $ref: "GridRange" },
        },
        type: "object",
      },
      AddProtectedRangeRequest: {
        properties: { protectedRange: { $ref: "ProtectedRange" } },
        type: "object",
      },
      ProtectedRange: {
        properties: {
          editors: { $ref: "Editors" },
          namedRangeId: { type: "string" },
          protectedRangeId: { format: "int32", type: "integer" },
          range: { $ref: "GridRange" },
          requestingUserCanEdit: { type: "boolean" },
          tableId: { type: "string" },
          unprotectedRanges: { items: { $ref: "GridRange" }, type: "array" },
          warningOnly: { type: "boolean" },
        },
        type: "object",
      },
      Editors: {
        properties: {
          domainUsersCanEdit: { type: "boolean" },
          groups: { items: { type: "string" }, type: "array" },
          users: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      AddSheetRequest: {
        properties: { properties: { $ref: "SheetProperties" } },
        type: "object",
      },
      SheetProperties: {
        properties: {
          dataSourceSheetProperties: {
            $ref: "DataSourceSheetProperties",
            readOnly: true,
          },
          gridProperties: { $ref: "GridProperties" },
          hidden: { type: "boolean" },
          index: { format: "int32", type: "integer" },
          rightToLeft: { type: "boolean" },
          sheetId: { format: "int32", type: "integer" },
          sheetType: {
            enum: ["SHEET_TYPE_UNSPECIFIED", "GRID", "OBJECT", "DATA_SOURCE"],
            type: "string",
          },
          tabColor: { $ref: "Color", deprecated: true },
          tabColorStyle: { $ref: "ColorStyle" },
          title: { type: "string" },
        },
        type: "object",
      },
      DataSourceSheetProperties: {
        properties: {
          columns: { items: { $ref: "DataSourceColumn" }, type: "array" },
          dataExecutionStatus: { $ref: "DataExecutionStatus" },
          dataSourceId: { type: "string" },
        },
        type: "object",
      },
      GridProperties: {
        properties: {
          columnCount: { format: "int32", type: "integer" },
          columnGroupControlAfter: { type: "boolean" },
          frozenColumnCount: { format: "int32", type: "integer" },
          frozenRowCount: { format: "int32", type: "integer" },
          hideGridlines: { type: "boolean" },
          rowCount: { format: "int32", type: "integer" },
          rowGroupControlAfter: { type: "boolean" },
        },
        type: "object",
      },
      AddSlicerRequest: {
        properties: { slicer: { $ref: "Slicer" } },
        type: "object",
      },
      Slicer: {
        properties: {
          position: { $ref: "EmbeddedObjectPosition" },
          slicerId: { format: "int32", type: "integer" },
          spec: { $ref: "SlicerSpec" },
        },
        type: "object",
      },
      SlicerSpec: {
        properties: {
          applyToPivotTables: { type: "boolean" },
          backgroundColor: { $ref: "Color", deprecated: true },
          backgroundColorStyle: { $ref: "ColorStyle" },
          columnIndex: { format: "int32", type: "integer" },
          dataRange: { $ref: "GridRange" },
          filterCriteria: { $ref: "FilterCriteria" },
          horizontalAlignment: {
            enum: ["HORIZONTAL_ALIGN_UNSPECIFIED", "LEFT", "CENTER", "RIGHT"],
            type: "string",
          },
          textFormat: { $ref: "TextFormat" },
          title: { type: "string" },
        },
        type: "object",
      },
      AddTableRequest: {
        properties: { table: { $ref: "Table" } },
        type: "object",
      },
      Table: {
        properties: {
          columnProperties: {
            items: { $ref: "TableColumnProperties" },
            type: "array",
          },
          name: { type: "string" },
          range: { $ref: "GridRange" },
          rowsProperties: { $ref: "TableRowsProperties" },
          tableId: { type: "string" },
        },
        type: "object",
      },
      TableColumnProperties: {
        properties: {
          columnIndex: { format: "int32", type: "integer" },
          columnName: { type: "string" },
          columnType: {
            enum: [
              "COLUMN_TYPE_UNSPECIFIED",
              "DOUBLE",
              "CURRENCY",
              "PERCENT",
              "DATE",
              "TIME",
              "DATE_TIME",
              "TEXT",
              "BOOLEAN",
              "DROPDOWN",
              "FILES_CHIP",
              "PEOPLE_CHIP",
              "FINANCE_CHIP",
              "PLACE_CHIP",
              "RATINGS_CHIP",
            ],
            type: "string",
          },
          dataValidationRule: { $ref: "TableColumnDataValidationRule" },
        },
        type: "object",
      },
      TableColumnDataValidationRule: {
        properties: { condition: { $ref: "BooleanCondition" } },
        type: "object",
      },
      TableRowsProperties: {
        properties: {
          firstBandColorStyle: { $ref: "ColorStyle" },
          footerColorStyle: { $ref: "ColorStyle" },
          headerColorStyle: { $ref: "ColorStyle" },
          secondBandColorStyle: { $ref: "ColorStyle" },
        },
        type: "object",
      },
      AppendCellsRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          rows: { items: { $ref: "RowData" }, type: "array" },
          sheetId: { format: "int32", type: "integer" },
          tableId: { type: "string" },
        },
        type: "object",
      },
      RowData: {
        properties: { values: { items: { $ref: "CellData" }, type: "array" } },
        type: "object",
      },
      CellData: {
        properties: {
          chipRuns: { items: { $ref: "ChipRun" }, type: "array" },
          dataSourceFormula: { $ref: "DataSourceFormula", readOnly: true },
          dataSourceTable: { $ref: "DataSourceTable" },
          dataValidation: { $ref: "DataValidationRule" },
          effectiveFormat: { $ref: "CellFormat" },
          effectiveValue: { $ref: "ExtendedValue" },
          formattedValue: { type: "string" },
          hyperlink: { type: "string" },
          note: { type: "string" },
          pivotTable: { $ref: "PivotTable" },
          textFormatRuns: { items: { $ref: "TextFormatRun" }, type: "array" },
          userEnteredFormat: { $ref: "CellFormat" },
          userEnteredValue: { $ref: "ExtendedValue" },
        },
        type: "object",
      },
      ChipRun: {
        properties: {
          chip: { $ref: "Chip" },
          startIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      Chip: {
        properties: {
          personProperties: { $ref: "PersonProperties" },
          richLinkProperties: { $ref: "RichLinkProperties" },
        },
        type: "object",
      },
      PersonProperties: {
        properties: {
          displayFormat: {
            enum: [
              "DISPLAY_FORMAT_UNSPECIFIED",
              "DEFAULT",
              "LAST_NAME_COMMA_FIRST_NAME",
              "EMAIL",
            ],
            type: "string",
          },
          email: { type: "string" },
        },
        type: "object",
      },
      RichLinkProperties: {
        properties: {
          mimeType: { readOnly: true, type: "string" },
          uri: { type: "string" },
        },
        type: "object",
      },
      DataSourceFormula: {
        properties: {
          dataExecutionStatus: { $ref: "DataExecutionStatus", readOnly: true },
          dataSourceId: { type: "string" },
        },
        type: "object",
      },
      DataSourceTable: {
        properties: {
          columnSelectionType: {
            enum: [
              "DATA_SOURCE_TABLE_COLUMN_SELECTION_TYPE_UNSPECIFIED",
              "SELECTED",
              "SYNC_ALL",
            ],
            type: "string",
          },
          columns: {
            items: { $ref: "DataSourceColumnReference" },
            type: "array",
          },
          dataExecutionStatus: { $ref: "DataExecutionStatus", readOnly: true },
          dataSourceId: { type: "string" },
          filterSpecs: { items: { $ref: "FilterSpec" }, type: "array" },
          rowLimit: { format: "int32", type: "integer" },
          sortSpecs: { items: { $ref: "SortSpec" }, type: "array" },
        },
        type: "object",
      },
      DataValidationRule: {
        properties: {
          condition: { $ref: "BooleanCondition" },
          inputMessage: { type: "string" },
          showCustomUi: { type: "boolean" },
          strict: { type: "boolean" },
        },
        type: "object",
      },
      ExtendedValue: {
        properties: {
          boolValue: { type: "boolean" },
          errorValue: { $ref: "ErrorValue" },
          formulaValue: { type: "string" },
          numberValue: { format: "double", type: "number" },
          stringValue: { type: "string" },
        },
        type: "object",
      },
      ErrorValue: {
        properties: {
          message: { type: "string" },
          type: {
            enum: [
              "ERROR_TYPE_UNSPECIFIED",
              "ERROR",
              "NULL_VALUE",
              "DIVIDE_BY_ZERO",
              "VALUE",
              "REF",
              "NAME",
              "NUM",
              "N_A",
              "LOADING",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      PivotTable: {
        properties: {
          columns: { items: { $ref: "PivotGroup" }, type: "array" },
          criteria: {
            additionalProperties: { $ref: "PivotFilterCriteria" },
            deprecated: true,
            type: "object",
          },
          dataExecutionStatus: { $ref: "DataExecutionStatus", readOnly: true },
          dataSourceId: { type: "string" },
          filterSpecs: { items: { $ref: "PivotFilterSpec" }, type: "array" },
          rows: { items: { $ref: "PivotGroup" }, type: "array" },
          source: { $ref: "GridRange" },
          valueLayout: { enum: ["HORIZONTAL", "VERTICAL"], type: "string" },
          values: { items: { $ref: "PivotValue" }, type: "array" },
        },
        type: "object",
      },
      PivotGroup: {
        properties: {
          dataSourceColumnReference: { $ref: "DataSourceColumnReference" },
          groupLimit: { $ref: "PivotGroupLimit" },
          groupRule: { $ref: "PivotGroupRule" },
          label: { type: "string" },
          repeatHeadings: { type: "boolean" },
          showTotals: { type: "boolean" },
          sortOrder: {
            enum: ["SORT_ORDER_UNSPECIFIED", "ASCENDING", "DESCENDING"],
            type: "string",
          },
          sourceColumnOffset: { format: "int32", type: "integer" },
          valueBucket: { $ref: "PivotGroupSortValueBucket" },
          valueMetadata: {
            items: { $ref: "PivotGroupValueMetadata" },
            type: "array",
          },
        },
        type: "object",
      },
      PivotGroupLimit: {
        properties: {
          applyOrder: { format: "int32", type: "integer" },
          countLimit: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      PivotGroupRule: {
        properties: {
          dateTimeRule: { $ref: "DateTimeRule" },
          histogramRule: { $ref: "HistogramRule" },
          manualRule: { $ref: "ManualRule" },
        },
        type: "object",
      },
      DateTimeRule: {
        properties: {
          type: {
            enum: [
              "DATE_TIME_RULE_TYPE_UNSPECIFIED",
              "SECOND",
              "MINUTE",
              "HOUR",
              "HOUR_MINUTE",
              "HOUR_MINUTE_AMPM",
              "DAY_OF_WEEK",
              "DAY_OF_YEAR",
              "DAY_OF_MONTH",
              "DAY_MONTH",
              "MONTH",
              "QUARTER",
              "YEAR",
              "YEAR_MONTH",
              "YEAR_QUARTER",
              "YEAR_MONTH_DAY",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      HistogramRule: {
        properties: {
          end: { format: "double", type: "number" },
          interval: { format: "double", type: "number" },
          start: { format: "double", type: "number" },
        },
        type: "object",
      },
      ManualRule: {
        properties: {
          groups: { items: { $ref: "ManualRuleGroup" }, type: "array" },
        },
        type: "object",
      },
      ManualRuleGroup: {
        properties: {
          groupName: { $ref: "ExtendedValue" },
          items: { items: { $ref: "ExtendedValue" }, type: "array" },
        },
        type: "object",
      },
      PivotGroupSortValueBucket: {
        properties: {
          buckets: { items: { $ref: "ExtendedValue" }, type: "array" },
          valuesIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      PivotGroupValueMetadata: {
        properties: {
          collapsed: { type: "boolean" },
          value: { $ref: "ExtendedValue" },
        },
        type: "object",
      },
      PivotFilterCriteria: {
        properties: {
          condition: { $ref: "BooleanCondition" },
          visibleByDefault: { type: "boolean" },
          visibleValues: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
      PivotFilterSpec: {
        properties: {
          columnOffsetIndex: { format: "int32", type: "integer" },
          dataSourceColumnReference: { $ref: "DataSourceColumnReference" },
          filterCriteria: { $ref: "PivotFilterCriteria" },
        },
        type: "object",
      },
      PivotValue: {
        properties: {
          calculatedDisplayType: {
            enum: [
              "PIVOT_VALUE_CALCULATED_DISPLAY_TYPE_UNSPECIFIED",
              "PERCENT_OF_ROW_TOTAL",
              "PERCENT_OF_COLUMN_TOTAL",
              "PERCENT_OF_GRAND_TOTAL",
            ],
            type: "string",
          },
          dataSourceColumnReference: { $ref: "DataSourceColumnReference" },
          formula: { type: "string" },
          name: { type: "string" },
          sourceColumnOffset: { format: "int32", type: "integer" },
          summarizeFunction: {
            enum: [
              "PIVOT_STANDARD_VALUE_FUNCTION_UNSPECIFIED",
              "SUM",
              "COUNTA",
              "COUNT",
              "COUNTUNIQUE",
              "AVERAGE",
              "MAX",
              "MIN",
              "MEDIAN",
              "PRODUCT",
              "STDEV",
              "STDEVP",
              "VAR",
              "VARP",
              "CUSTOM",
              "NONE",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      TextFormatRun: {
        properties: {
          format: { $ref: "TextFormat" },
          startIndex: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      AppendDimensionRequest: {
        properties: {
          dimension: {
            enum: ["DIMENSION_UNSPECIFIED", "ROWS", "COLUMNS"],
            type: "string",
          },
          length: { format: "int32", type: "integer" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      AutoFillRequest: {
        properties: {
          range: { $ref: "GridRange" },
          sourceAndDestination: { $ref: "SourceAndDestination" },
          useAlternateSeries: { type: "boolean" },
        },
        type: "object",
      },
      SourceAndDestination: {
        properties: {
          dimension: {
            enum: ["DIMENSION_UNSPECIFIED", "ROWS", "COLUMNS"],
            type: "string",
          },
          fillLength: { format: "int32", type: "integer" },
          source: { $ref: "GridRange" },
        },
        type: "object",
      },
      AutoResizeDimensionsRequest: {
        properties: {
          dataSourceSheetDimensions: { $ref: "DataSourceSheetDimensionRange" },
          dimensions: { $ref: "DimensionRange" },
        },
        type: "object",
      },
      DataSourceSheetDimensionRange: {
        properties: {
          columnReferences: {
            items: { $ref: "DataSourceColumnReference" },
            type: "array",
          },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      CancelDataSourceRefreshRequest: {
        properties: {
          dataSourceId: { type: "string" },
          isAll: { type: "boolean" },
          references: { $ref: "DataSourceObjectReferences" },
        },
        type: "object",
      },
      DataSourceObjectReferences: {
        properties: {
          references: {
            items: { $ref: "DataSourceObjectReference" },
            type: "array",
          },
        },
        type: "object",
      },
      DataSourceObjectReference: {
        properties: {
          chartId: { format: "int32", type: "integer" },
          dataSourceFormulaCell: { $ref: "GridCoordinate" },
          dataSourcePivotTableAnchorCell: { $ref: "GridCoordinate" },
          dataSourceTableAnchorCell: { $ref: "GridCoordinate" },
          sheetId: { type: "string" },
        },
        type: "object",
      },
      ClearBasicFilterRequest: {
        properties: { sheetId: { format: "int32", type: "integer" } },
        type: "object",
      },
      CopyPasteRequest: {
        properties: {
          destination: { $ref: "GridRange" },
          pasteOrientation: { enum: ["NORMAL", "TRANSPOSE"], type: "string" },
          pasteType: {
            enum: [
              "PASTE_NORMAL",
              "PASTE_VALUES",
              "PASTE_FORMAT",
              "PASTE_NO_BORDERS",
              "PASTE_FORMULA",
              "PASTE_DATA_VALIDATION",
              "PASTE_CONDITIONAL_FORMATTING",
            ],
            type: "string",
          },
          source: { $ref: "GridRange" },
        },
        type: "object",
      },
      CreateDeveloperMetadataRequest: {
        properties: { developerMetadata: { $ref: "DeveloperMetadata" } },
        type: "object",
      },
      DeveloperMetadata: {
        properties: {
          location: { $ref: "DeveloperMetadataLocation" },
          metadataId: { format: "int32", type: "integer" },
          metadataKey: { type: "string" },
          metadataValue: { type: "string" },
          visibility: {
            enum: [
              "DEVELOPER_METADATA_VISIBILITY_UNSPECIFIED",
              "DOCUMENT",
              "PROJECT",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      DeveloperMetadataLocation: {
        properties: {
          dimensionRange: { $ref: "DimensionRange" },
          locationType: {
            enum: [
              "DEVELOPER_METADATA_LOCATION_TYPE_UNSPECIFIED",
              "ROW",
              "COLUMN",
              "SHEET",
              "SPREADSHEET",
            ],
            type: "string",
          },
          sheetId: { format: "int32", type: "integer" },
          spreadsheet: { type: "boolean" },
        },
        type: "object",
      },
      CutPasteRequest: {
        properties: {
          destination: { $ref: "GridCoordinate" },
          pasteType: {
            enum: [
              "PASTE_NORMAL",
              "PASTE_VALUES",
              "PASTE_FORMAT",
              "PASTE_NO_BORDERS",
              "PASTE_FORMULA",
              "PASTE_DATA_VALIDATION",
              "PASTE_CONDITIONAL_FORMATTING",
            ],
            type: "string",
          },
          source: { $ref: "GridRange" },
        },
        type: "object",
      },
      DeleteBandingRequest: {
        properties: { bandedRangeId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DeleteConditionalFormatRuleRequest: {
        properties: {
          index: { format: "int32", type: "integer" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      DeleteDataSourceRequest: {
        properties: { dataSourceId: { type: "string" } },
        type: "object",
      },
      DeleteDeveloperMetadataRequest: {
        properties: { dataFilter: { $ref: "DataFilter" } },
        type: "object",
      },
      DataFilter: {
        properties: {
          a1Range: { type: "string" },
          developerMetadataLookup: { $ref: "DeveloperMetadataLookup" },
          gridRange: { $ref: "GridRange" },
        },
        type: "object",
      },
      DeveloperMetadataLookup: {
        properties: {
          locationMatchingStrategy: {
            enum: [
              "DEVELOPER_METADATA_LOCATION_MATCHING_STRATEGY_UNSPECIFIED",
              "EXACT_LOCATION",
              "INTERSECTING_LOCATION",
            ],
            type: "string",
          },
          locationType: {
            enum: [
              "DEVELOPER_METADATA_LOCATION_TYPE_UNSPECIFIED",
              "ROW",
              "COLUMN",
              "SHEET",
              "SPREADSHEET",
            ],
            type: "string",
          },
          metadataId: { format: "int32", type: "integer" },
          metadataKey: { type: "string" },
          metadataLocation: { $ref: "DeveloperMetadataLocation" },
          metadataValue: { type: "string" },
          visibility: {
            enum: [
              "DEVELOPER_METADATA_VISIBILITY_UNSPECIFIED",
              "DOCUMENT",
              "PROJECT",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      DeleteDimensionRequest: {
        properties: { range: { $ref: "DimensionRange" } },
        type: "object",
      },
      DeleteDimensionGroupRequest: {
        properties: { range: { $ref: "DimensionRange" } },
        type: "object",
      },
      DeleteDuplicatesRequest: {
        properties: {
          comparisonColumns: {
            items: { $ref: "DimensionRange" },
            type: "array",
          },
          range: { $ref: "GridRange" },
        },
        type: "object",
      },
      DeleteEmbeddedObjectRequest: {
        properties: { objectId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DeleteFilterViewRequest: {
        properties: { filterId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DeleteNamedRangeRequest: {
        properties: { namedRangeId: { type: "string" } },
        type: "object",
      },
      DeleteProtectedRangeRequest: {
        properties: { protectedRangeId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DeleteRangeRequest: {
        properties: {
          range: { $ref: "GridRange" },
          shiftDimension: {
            enum: ["DIMENSION_UNSPECIFIED", "ROWS", "COLUMNS"],
            type: "string",
          },
        },
        type: "object",
      },
      DeleteSheetRequest: {
        properties: { sheetId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DeleteTableRequest: {
        properties: { tableId: { type: "string" } },
        type: "object",
      },
      DuplicateFilterViewRequest: {
        properties: { filterId: { format: "int32", type: "integer" } },
        type: "object",
      },
      DuplicateSheetRequest: {
        properties: {
          insertSheetIndex: { format: "int32", type: "integer" },
          newSheetId: { format: "int32", type: "integer" },
          newSheetName: { type: "string" },
          sourceSheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      FindReplaceRequest: {
        properties: {
          allSheets: { type: "boolean" },
          find: { type: "string" },
          includeFormulas: { type: "boolean" },
          matchCase: { type: "boolean" },
          matchEntireCell: { type: "boolean" },
          range: { $ref: "GridRange" },
          replacement: { type: "string" },
          searchByRegex: { type: "boolean" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      InsertDimensionRequest: {
        properties: {
          inheritFromBefore: { type: "boolean" },
          range: { $ref: "DimensionRange" },
        },
        type: "object",
      },
      InsertRangeRequest: {
        properties: {
          range: { $ref: "GridRange" },
          shiftDimension: {
            enum: ["DIMENSION_UNSPECIFIED", "ROWS", "COLUMNS"],
            type: "string",
          },
        },
        type: "object",
      },
      MergeCellsRequest: {
        properties: {
          mergeType: {
            enum: ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"],
            type: "string",
          },
          range: { $ref: "GridRange" },
        },
        type: "object",
      },
      MoveDimensionRequest: {
        properties: {
          destinationIndex: { format: "int32", type: "integer" },
          source: { $ref: "DimensionRange" },
        },
        type: "object",
      },
      PasteDataRequest: {
        properties: {
          coordinate: { $ref: "GridCoordinate" },
          data: { type: "string" },
          delimiter: { type: "string" },
          html: { type: "boolean" },
          type: {
            enum: [
              "PASTE_NORMAL",
              "PASTE_VALUES",
              "PASTE_FORMAT",
              "PASTE_NO_BORDERS",
              "PASTE_FORMULA",
              "PASTE_DATA_VALIDATION",
              "PASTE_CONDITIONAL_FORMATTING",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      RandomizeRangeRequest: {
        properties: { range: { $ref: "GridRange" } },
        type: "object",
      },
      RefreshDataSourceRequest: {
        properties: {
          dataSourceId: { type: "string" },
          force: { type: "boolean" },
          isAll: { type: "boolean" },
          references: { $ref: "DataSourceObjectReferences" },
        },
        type: "object",
      },
      RepeatCellRequest: {
        properties: {
          cell: { $ref: "CellData" },
          fields: { format: "google-fieldmask", type: "string" },
          range: { $ref: "GridRange" },
        },
        type: "object",
      },
      SetBasicFilterRequest: {
        properties: { filter: { $ref: "BasicFilter" } },
        type: "object",
      },
      BasicFilter: {
        properties: {
          criteria: {
            additionalProperties: { $ref: "FilterCriteria" },
            deprecated: true,
            type: "object",
          },
          filterSpecs: { items: { $ref: "FilterSpec" }, type: "array" },
          range: { $ref: "GridRange" },
          sortSpecs: { items: { $ref: "SortSpec" }, type: "array" },
          tableId: { type: "string" },
        },
        type: "object",
      },
      SetDataValidationRequest: {
        properties: {
          filteredRowsIncluded: { type: "boolean" },
          range: { $ref: "GridRange" },
          rule: { $ref: "DataValidationRule" },
        },
        type: "object",
      },
      SortRangeRequest: {
        properties: {
          range: { $ref: "GridRange" },
          sortSpecs: { items: { $ref: "SortSpec" }, type: "array" },
        },
        type: "object",
      },
      TextToColumnsRequest: {
        properties: {
          delimiter: { type: "string" },
          delimiterType: {
            enum: [
              "DELIMITER_TYPE_UNSPECIFIED",
              "COMMA",
              "SEMICOLON",
              "PERIOD",
              "SPACE",
              "CUSTOM",
              "AUTODETECT",
            ],
            type: "string",
          },
          source: { $ref: "GridRange" },
        },
        type: "object",
      },
      TrimWhitespaceRequest: {
        properties: { range: { $ref: "GridRange" } },
        type: "object",
      },
      UnmergeCellsRequest: {
        properties: { range: { $ref: "GridRange" } },
        type: "object",
      },
      UpdateBandingRequest: {
        properties: {
          bandedRange: { $ref: "BandedRange" },
          fields: { format: "google-fieldmask", type: "string" },
        },
        type: "object",
      },
      UpdateBordersRequest: {
        properties: {
          bottom: { $ref: "Border" },
          innerHorizontal: { $ref: "Border" },
          innerVertical: { $ref: "Border" },
          left: { $ref: "Border" },
          range: { $ref: "GridRange" },
          right: { $ref: "Border" },
          top: { $ref: "Border" },
        },
        type: "object",
      },
      UpdateCellsRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          range: { $ref: "GridRange" },
          rows: { items: { $ref: "RowData" }, type: "array" },
          start: { $ref: "GridCoordinate" },
        },
        type: "object",
      },
      UpdateChartSpecRequest: {
        properties: {
          chartId: { format: "int32", type: "integer" },
          spec: { $ref: "ChartSpec" },
        },
        type: "object",
      },
      UpdateConditionalFormatRuleRequest: {
        properties: {
          index: { format: "int32", type: "integer" },
          newIndex: { format: "int32", type: "integer" },
          rule: { $ref: "ConditionalFormatRule" },
          sheetId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      UpdateDataSourceRequest: {
        properties: {
          dataSource: { $ref: "DataSource" },
          fields: { format: "google-fieldmask", type: "string" },
        },
        type: "object",
      },
      UpdateDeveloperMetadataRequest: {
        properties: {
          dataFilters: { items: { $ref: "DataFilter" }, type: "array" },
          developerMetadata: { $ref: "DeveloperMetadata" },
          fields: { format: "google-fieldmask", type: "string" },
        },
        type: "object",
      },
      UpdateDimensionGroupRequest: {
        properties: {
          dimensionGroup: { $ref: "DimensionGroup" },
          fields: { format: "google-fieldmask", type: "string" },
        },
        type: "object",
      },
      DimensionGroup: {
        properties: {
          collapsed: { type: "boolean" },
          depth: { format: "int32", type: "integer" },
          range: { $ref: "DimensionRange" },
        },
        type: "object",
      },
      UpdateDimensionPropertiesRequest: {
        properties: {
          dataSourceSheetRange: { $ref: "DataSourceSheetDimensionRange" },
          fields: { format: "google-fieldmask", type: "string" },
          properties: { $ref: "DimensionProperties" },
          range: { $ref: "DimensionRange" },
        },
        type: "object",
      },
      DimensionProperties: {
        properties: {
          dataSourceColumnReference: {
            $ref: "DataSourceColumnReference",
            readOnly: true,
          },
          developerMetadata: {
            items: { $ref: "DeveloperMetadata" },
            type: "array",
          },
          hiddenByFilter: { type: "boolean" },
          hiddenByUser: { type: "boolean" },
          pixelSize: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      UpdateEmbeddedObjectBorderRequest: {
        properties: {
          border: { $ref: "EmbeddedObjectBorder" },
          fields: { format: "google-fieldmask", type: "string" },
          objectId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      UpdateEmbeddedObjectPositionRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          newPosition: { $ref: "EmbeddedObjectPosition" },
          objectId: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      UpdateFilterViewRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          filter: { $ref: "FilterView" },
        },
        type: "object",
      },
      UpdateNamedRangeRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          namedRange: { $ref: "NamedRange" },
        },
        type: "object",
      },
      UpdateProtectedRangeRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          protectedRange: { $ref: "ProtectedRange" },
        },
        type: "object",
      },
      UpdateSheetPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          properties: { $ref: "SheetProperties" },
        },
        type: "object",
      },
      UpdateSlicerSpecRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          slicerId: { format: "int32", type: "integer" },
          spec: { $ref: "SlicerSpec" },
        },
        type: "object",
      },
      UpdateSpreadsheetPropertiesRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          properties: { $ref: "SpreadsheetProperties" },
        },
        type: "object",
      },
      SpreadsheetProperties: {
        properties: {
          autoRecalc: {
            enum: [
              "RECALCULATION_INTERVAL_UNSPECIFIED",
              "ON_CHANGE",
              "MINUTE",
              "HOUR",
            ],
            type: "string",
          },
          defaultFormat: { $ref: "CellFormat" },
          importFunctionsExternalUrlAccessAllowed: { type: "boolean" },
          iterativeCalculationSettings: {
            $ref: "IterativeCalculationSettings",
          },
          locale: { type: "string" },
          spreadsheetTheme: { $ref: "SpreadsheetTheme" },
          timeZone: { type: "string" },
          title: { type: "string" },
        },
        type: "object",
      },
      IterativeCalculationSettings: {
        properties: {
          convergenceThreshold: { format: "double", type: "number" },
          maxIterations: { format: "int32", type: "integer" },
        },
        type: "object",
      },
      SpreadsheetTheme: {
        properties: {
          primaryFontFamily: { type: "string" },
          themeColors: { items: { $ref: "ThemeColorPair" }, type: "array" },
        },
        type: "object",
      },
      ThemeColorPair: {
        properties: {
          color: { $ref: "ColorStyle" },
          colorType: {
            enum: [
              "THEME_COLOR_TYPE_UNSPECIFIED",
              "TEXT",
              "BACKGROUND",
              "ACCENT1",
              "ACCENT2",
              "ACCENT3",
              "ACCENT4",
              "ACCENT5",
              "ACCENT6",
              "LINK",
            ],
            type: "string",
          },
        },
        type: "object",
      },
      UpdateTableRequest: {
        properties: {
          fields: { format: "google-fieldmask", type: "string" },
          table: { $ref: "Table" },
        },
        type: "object",
      },
    },
  },
};
